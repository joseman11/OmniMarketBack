import express from "express";
import { createApp } from "./application.js";

// Vercel detects Express from imports in the entrypoint file itself.
const app = createApp(express());

export default app;
