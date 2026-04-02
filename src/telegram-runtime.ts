import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

type TelegramRuntimeModule = {
  sendMessageTelegram: (to: string, text: string, opts?: any) => Promise<any>;
  sendTypingTelegram: (to: string, opts?: any) => Promise<any>;
  resolveTelegramToken: (cfg?: any, opts?: any) => any;
  renameForumTopicTelegram: (
    chatId: string | number,
    messageThreadId: string | number,
    name: string,
    opts?: any,
  ) => Promise<any>;
};

const require = createRequire(import.meta.url);
let telegramRuntimeModulePromise: Promise<TelegramRuntimeModule> | null = null;

async function loadTelegramRuntimeModule(): Promise<TelegramRuntimeModule> {
  if (!telegramRuntimeModulePromise) {
    const openclawPackageJson = require.resolve("openclaw/package.json");
    const runtimeApiPath = path.join(
      path.dirname(openclawPackageJson),
      "dist",
      "extensions",
      "telegram",
      "runtime-api.js",
    );
    telegramRuntimeModulePromise = import(pathToFileURL(runtimeApiPath).href) as Promise<TelegramRuntimeModule>;
  }
  return await telegramRuntimeModulePromise;
}

export async function sendMessageTelegram(to: string, text: string, opts?: any): Promise<any> {
  const runtime = await loadTelegramRuntimeModule();
  return await runtime.sendMessageTelegram(to, text, opts);
}

export async function sendTypingTelegram(to: string, opts?: any): Promise<any> {
  const runtime = await loadTelegramRuntimeModule();
  return await runtime.sendTypingTelegram(to, opts);
}

export async function resolveTelegramToken(cfg?: any, opts?: any): Promise<any> {
  const runtime = await loadTelegramRuntimeModule();
  return runtime.resolveTelegramToken(cfg, opts);
}

export async function renameForumTopicTelegram(
  chatId: string | number,
  messageThreadId: string | number,
  name: string,
  opts?: any,
): Promise<any> {
  const runtime = await loadTelegramRuntimeModule();
  return await runtime.renameForumTopicTelegram(chatId, messageThreadId, name, opts);
}
