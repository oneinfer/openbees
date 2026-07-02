import { Router } from 'express';
import { initSSE } from '../events.js';
import { getRun, sendSnapshot, subscribe } from '../live-chat.js';

export const voiceAssistantRouter = Router();

// Ad-hoc voice-conversation sessions have no backing Task row (see server/voice-assistant.ts),
// so this always serves locally from the in-memory live-chat run store rather than proxying
// to the enterprise server the way task-scoped chat/live does.
voiceAssistantRouter.get('/sessions/:id/live', (req, res) => {
  const run = getRun(req.params.id);
  initSSE(res);
  subscribe(req.params.id, res);
  if (run) sendSnapshot(res, run);
});
