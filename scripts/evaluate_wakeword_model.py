from __future__ import annotations

import argparse
import audioop
from pathlib import Path
import statistics
import wave

import numpy as np
from openwakeword.model import Model


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODEL = ROOT / "activity_daemon" / "models" / "hey_bee.onnx"
DEFAULT_FEATURE_DIR = ROOT / "activity_daemon" / "models" / "openwakeword"


def read_wav_16khz_mono(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as wav:
        channels = wav.getnchannels()
        sample_width = wav.getsampwidth()
        sample_rate = wav.getframerate()
        frames = wav.readframes(wav.getnframes())

    if sample_width != 2:
        frames = audioop.lin2lin(frames, sample_width, 2)
        sample_width = 2
    if channels > 1:
        frames = audioop.tomono(frames, sample_width, 0.5, 0.5)
    if sample_rate != 16000:
        frames, _ = audioop.ratecv(frames, sample_width, 1, sample_rate, 16000, None)

    return np.frombuffer(frames, dtype=np.int16)


def load_model(model_path: Path, feature_dir: Path) -> tuple[Model, str]:
    kwargs = {
        "wakeword_models": [str(model_path)],
        "inference_framework": "onnx",
    }

    melspec = feature_dir / "melspectrogram.onnx"
    embedding = feature_dir / "embedding_model.onnx"
    if melspec.exists() and embedding.exists():
        kwargs["melspec_model_path"] = str(melspec)
        kwargs["embedding_model_path"] = str(embedding)

    model = Model(**kwargs)
    return model, next(iter(model.models.keys()))


def score_file(model: Model, model_name: str, path: Path, chunk_size: int) -> float:
    reset = getattr(model, "reset", None)
    if callable(reset):
        reset()

    audio = read_wav_16khz_mono(path)
    if audio.size == 0:
        return 0.0

    max_score = 0.0
    for start in range(0, audio.size, chunk_size):
        chunk = audio[start:start + chunk_size]
        if chunk.size < chunk_size:
            chunk = np.pad(chunk, (0, chunk_size - chunk.size))
        prediction = model.predict(chunk)
        max_score = max(max_score, float(prediction.get(model_name, 0.0)))
    return max_score


def wav_files(path: Path | None) -> list[Path]:
    if path is None or not path.exists():
        return []
    return sorted(path.rglob("*.wav"))


def describe(label: str, scores: list[tuple[Path, float]], threshold: float, positive: bool) -> None:
    print(f"\n{label}: {len(scores)} files")
    if not scores:
        return

    values = [score for _, score in scores]
    print(
        "  score min/p50/p95/max: "
        f"{min(values):.3f} / "
        f"{statistics.median(values):.3f} / "
        f"{np.percentile(values, 95):.3f} / "
        f"{max(values):.3f}"
    )

    if positive:
        misses = [(path, score) for path, score in scores if score < threshold]
        print(f"  recall: {(len(scores) - len(misses)) / len(scores):.1%}")
        for path, score in sorted(misses, key=lambda item: item[1])[:10]:
            print(f"  miss {score:.3f}: {path}")
    else:
        false_accepts = [(path, score) for path, score in scores if score >= threshold]
        print(f"  false accepts: {len(false_accepts)} ({len(false_accepts) / len(scores):.1%})")
        for path, score in sorted(false_accepts, key=lambda item: item[1], reverse=True)[:10]:
            print(f"  false accept {score:.3f}: {path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate the hey bee openWakeWord model on labeled WAV folders.")
    parser.add_argument("--model", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--feature-dir", type=Path, default=DEFAULT_FEATURE_DIR)
    parser.add_argument("--positive-dir", type=Path, help="Folder containing WAVs that include the wake phrase.")
    parser.add_argument("--negative-dir", type=Path, help="Folder containing WAVs without the wake phrase.")
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--chunk-size", type=int, default=1280)
    args = parser.parse_args()

    model, model_name = load_model(args.model, args.feature_dir)
    print(f"model: {args.model}")
    print(f"model name: {model_name}")
    print(f"threshold: {args.threshold:.2f}")

    positive_scores = [
        (path, score_file(model, model_name, path, args.chunk_size))
        for path in wav_files(args.positive_dir)
    ]
    negative_scores = [
        (path, score_file(model, model_name, path, args.chunk_size))
        for path in wav_files(args.negative_dir)
    ]

    describe("positive wake clips", positive_scores, args.threshold, positive=True)
    describe("negative clips", negative_scores, args.threshold, positive=False)

    if not positive_scores and not negative_scores:
        print("\nNo WAV files were found. Pass --positive-dir and/or --negative-dir.")


if __name__ == "__main__":
    main()
