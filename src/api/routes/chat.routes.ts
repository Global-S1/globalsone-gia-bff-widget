import { Router } from "express";
import { createChat } from "../controllers/chat.controller";

export function chatRoutes(): Router {
  const router = Router();

  // POST /v1/chat/create-chat — endpoint público consumido por el widget.
  router.post("/create-chat", createChat);

  return router;
}
