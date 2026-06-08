from __future__ import annotations

import base64
import ctypes
from pathlib import Path
import time
from typing import Any


SEARCH_PADDING_X = 260
SEARCH_PADDING_Y = 160
CROP_PADDING_PIXELS = 22
MIN_SEARCH_WIDTH = 700
MIN_SEARCH_HEIGHT = 360


def enable_dpi_aware_coordinates() -> None:
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass


def clamp_region_to_screen(left: int, top: int, right: int, bottom: int, screen: dict[str, int]) -> dict[str, int]:
    screen_left = screen["left"]
    screen_top = screen["top"]
    screen_right = screen_left + screen["width"]
    screen_bottom = screen_top + screen["height"]

    width = min(max(1, right - left), screen["width"])
    height = min(max(1, bottom - top), screen["height"])

    left = max(screen_left, min(left, screen_right - width))
    top = max(screen_top, min(top, screen_bottom - height))

    return {"left": int(left), "top": int(top), "width": int(width), "height": int(height)}


def expand_region_to_min_size(left: int, top: int, right: int, bottom: int) -> tuple[int, int, int, int]:
    width = right - left
    height = bottom - top

    if width < MIN_SEARCH_WIDTH:
        extra = MIN_SEARCH_WIDTH - width
        left -= extra // 2
        right += extra - (extra // 2)

    if height < MIN_SEARCH_HEIGHT:
        extra = MIN_SEARCH_HEIGHT - height
        top -= extra // 2
        bottom += extra - (extra // 2)

    return left, top, right, bottom


def is_selection_blue(r: int, g: int, b: int) -> bool:
    return b >= 120 and r <= 90 and 45 <= g <= 170 and b >= g + 35


def find_highlight_bounds(screenshot: Any) -> tuple[int, int, int, int] | None:
    width, height = screenshot.size
    rgb = screenshot.rgb

    min_x = width
    min_y = height
    max_x = -1
    max_y = -1
    highlighted_pixels = 0

    for y in range(height):
        row_offset = y * width * 3
        for x in range(width):
            offset = row_offset + x * 3
            r = rgb[offset]
            g = rgb[offset + 1]
            b = rgb[offset + 2]
            if is_selection_blue(r, g, b):
                highlighted_pixels += 1
                min_x = min(min_x, x)
                min_y = min(min_y, y)
                max_x = max(max_x, x)
                max_y = max(max_y, y)

    if highlighted_pixels < 30:
        return None

    return min_x, min_y, max_x + 1, max_y + 1


def get_search_region(start_pos: tuple[int, int], end_pos: tuple[int, int], screen: dict[str, int]) -> dict[str, int]:
    x1, y1 = start_pos
    x2, y2 = end_pos
    left = min(x1, x2) - SEARCH_PADDING_X
    top = min(y1, y2) - SEARCH_PADDING_Y
    right = max(x1, x2) + SEARCH_PADDING_X
    bottom = max(y1, y2) + SEARCH_PADDING_Y
    left, top, right, bottom = expand_region_to_min_size(left, top, right, bottom)
    return clamp_region_to_screen(left, top, right, bottom, screen)


def get_drag_fallback_region(start_pos: tuple[int, int], end_pos: tuple[int, int], screen: dict[str, int]) -> dict[str, int]:
    x1, y1 = start_pos
    x2, y2 = end_pos
    return clamp_region_to_screen(
        min(x1, x2) - CROP_PADDING_PIXELS,
        min(y1, y2) - CROP_PADDING_PIXELS,
        max(x1, x2) + CROP_PADDING_PIXELS,
        max(y1, y2) + CROP_PADDING_PIXELS,
        screen,
    )


def get_cursor_region(position: tuple[int, int], size: int, screen: dict[str, int]) -> dict[str, int]:
    x, y = position
    half = size // 2
    return clamp_region_to_screen(x - half, y - half, x + half, y + half, screen)


def crop_region_to_highlight(search_region: dict[str, int], highlight_bounds: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    left = search_region["left"] + highlight_bounds[0] - CROP_PADDING_PIXELS
    top = search_region["top"] + highlight_bounds[1] - CROP_PADDING_PIXELS
    right = search_region["left"] + highlight_bounds[2] + CROP_PADDING_PIXELS
    bottom = search_region["top"] + highlight_bounds[3] + CROP_PADDING_PIXELS
    return left, top, right, bottom


class ScreenCapture:
    def __init__(self, images_dir: Path, cursor_crop_size: int = 400) -> None:
        self.images_dir = images_dir
        self.cursor_crop_size = cursor_crop_size
        self.images_dir.mkdir(parents=True, exist_ok=True)
        enable_dpi_aware_coordinates()

    def availability(self) -> dict[str, Any]:
        try:
            import mss  # noqa: F401
            return {"enabled": True, "available": True, "permission_required": False, "last_error": None}
        except Exception as error:
            return {"enabled": True, "available": False, "permission_required": False, "last_error": str(error)}

    def _save_screenshot(self, sct: Any, region: dict[str, int], prefix: str, output_dir: Path | None = None, draw_path: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        from mss.tools import to_png
        from PIL import Image, ImageDraw

        image_dir = output_dir or self.images_dir
        image_dir.mkdir(parents=True, exist_ok=True)
        screenshot = sct.grab(region)
        timestamp = int(time.time() * 1000)
        path = image_dir / f"{prefix}_{timestamp}.png"

        if draw_path and len(draw_path) > 1:
            img = Image.frombytes("RGB", screenshot.size, screenshot.bgra, "raw", "BGRX")
            draw = ImageDraw.Draw(img, "RGBA")
            
            points = []
            for point in draw_path:
                x = point["x"] - region["left"]
                y = point["y"] - region["top"]
                points.append((x, y))
            
            # Draw line with semi-transparent red color
            draw.line(points, fill=(255, 0, 0, 180), width=6, joint="curve")
            
            # Draw a circle at the last position (cursor)
            if points:
                last_x, last_y = points[-1]
                radius = 6
                draw.ellipse([last_x - radius, last_y - radius, last_x + radius, last_y + radius], fill=(255, 0, 0, 200))

            img.save(str(path))
        else:
            to_png(screenshot.rgb, screenshot.size, output=str(path))

        print(
            f"[activity-daemon] saved screenshot image: prefix={prefix}, path={path}, size={screenshot.size[0]}x{screenshot.size[1]}",
            flush=True,
        )
        return {"path": str(path), "region": region, "width": screenshot.size[0], "height": screenshot.size[1]}

    def capture_context_images(
        self,
        mouse_position: tuple[int, int] | None,
        drag_start: tuple[int, int] | None = None,
        drag_end: tuple[int, int] | None = None,
        include_base64: bool = False,
        include_full_screen: bool = False,
        include_cursor_crop: bool = True,
        include_selection_crop: bool = True,
        output_dir: Path | None = None,
        recent_path: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        import mss

        images: dict[str, Any] = {"cursor_crop": None, "selection_crop": None, "screenshot": None}
        with mss.MSS() as sct:
            screen = sct.monitors[0]
            if include_full_screen:
                images["screenshot"] = self._save_screenshot(sct, screen, "screenshot", output_dir, draw_path=recent_path)

            if include_cursor_crop and mouse_position:
                cursor_region = get_cursor_region(mouse_position, self.cursor_crop_size, screen)
                images["cursor_crop"] = self._save_screenshot(sct, cursor_region, "cursor", output_dir)

            if include_selection_crop and drag_start and drag_end:
                search_region = get_search_region(drag_start, drag_end, screen)
                search_screenshot = sct.grab(search_region)
                highlight_bounds = find_highlight_bounds(search_screenshot)
                if highlight_bounds:
                    crop_left, crop_top, crop_right, crop_bottom = crop_region_to_highlight(search_region, highlight_bounds)
                    final_region = clamp_region_to_screen(crop_left, crop_top, crop_right, crop_bottom, screen)
                    images["selection_crop"] = self._save_screenshot(sct, final_region, "selected_text", output_dir)
                    images["selection_crop"]["source"] = "highlight"
                else:
                    fallback_region = get_drag_fallback_region(drag_start, drag_end, screen)
                    images["selection_crop"] = self._save_screenshot(sct, fallback_region, "drag_region", output_dir)
                    images["selection_crop"]["source"] = "drag_fallback"

        if include_base64:
            for item in images.values():
                if item and item.get("path"):
                    item["base64"] = base64.b64encode(Path(item["path"]).read_bytes()).decode("ascii")

        return images
