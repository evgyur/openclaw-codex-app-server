import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi, PluginCommandContext, ReplyPayload } from "openclaw/plugin-sdk";
import { CodexAppServerClient } from "./client.js";
import { CodexPluginController } from "./controller.js";
import { PluginStateStore, buildConversationKey, buildConversationSessionKey } from "./state.js";

const TEST_TELEGRAM_PEER_ID = "telegram-user-1";
const DISCORD_SDK_OVERRIDE_KEY = "__OPENCLAW_CODEX_APP_SERVER_TEST_DISCORD_SDK__";

const discordSdkState = vi.hoisted(() => ({
  buildDiscordComponentMessage: vi.fn((params: { spec: { text?: string; blocks?: unknown[] } }) => ({
    components: [params.spec.text ?? "", ...(params.spec.blocks ?? [])],
    entries: [{ id: "entry-1", kind: "button", label: "Tap" }],
    modals: [],
  })),
  editDiscordComponentMessage: vi.fn(async () => ({
    messageId: "message-1",
    channelId: "channel:chan-1",
  })),
  registerBuiltDiscordComponentMessage: vi.fn(),
  resolveDiscordAccount: vi.fn(() => ({ accountId: "default", token: "discord-token" })),
}));

(globalThis as typeof globalThis & Record<string, unknown>)[DISCORD_SDK_OVERRIDE_KEY] = discordSdkState;

function makeStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-app-server-test-"));
}

function createApiMock() {
  const stateDir = makeStateDir();
  const sendComponentMessage = vi.fn(async (..._args: unknown[]) => ({ messageId: "discord-component-1", channelId: "channel:chan-1" }));
  const sendMessageDiscord = vi.fn(async (..._args: unknown[]) => ({ messageId: "discord-msg-1", channelId: "channel:chan-1" }));
  const sendMessageTelegram = vi.fn(async (..._args: unknown[]) => ({ messageId: "1", chatId: "123" }));
  const discordTypingStart = vi.fn(async () => ({ refresh: vi.fn(async () => {}), stop: vi.fn() }));
  const renameTopic = vi.fn(async () => ({}));
  const resolveTelegramToken = vi.fn(() => ({ token: "telegram-token", source: "config" }));
  const editChannel = vi.fn(async () => ({}));
  const telegramOutbound = {
    sendText: vi.fn(async (ctx: { to: string; text: string; accountId?: string; threadId?: string | number }) =>
      await sendMessageTelegram(ctx.to, ctx.text, {
        accountId: ctx.accountId,
        messageThreadId: typeof ctx.threadId === "number" ? ctx.threadId : undefined,
      }),
    ),
    sendMedia: vi.fn(
      async (ctx: {
        to: string;
        text: string;
        mediaUrl: string;
        accountId?: string;
        threadId?: string | number;
        mediaLocalRoots?: readonly string[];
      }) =>
        await sendMessageTelegram(ctx.to, ctx.text, {
          accountId: ctx.accountId,
          messageThreadId: typeof ctx.threadId === "number" ? ctx.threadId : undefined,
          mediaUrl: ctx.mediaUrl,
          mediaLocalRoots: ctx.mediaLocalRoots,
        }),
    ),
    sendPayload: vi.fn(
      async (ctx: {
        to: string;
        payload: ReplyPayload;
        accountId?: string;
        threadId?: string | number;
        mediaLocalRoots?: readonly string[];
      }) =>
        await sendMessageTelegram(ctx.to, ctx.payload.text ?? "", {
          accountId: ctx.accountId,
          messageThreadId: typeof ctx.threadId === "number" ? ctx.threadId : undefined,
          mediaUrl: ctx.payload.mediaUrl,
          mediaLocalRoots: ctx.mediaLocalRoots,
          buttons: (ctx.payload.channelData as { telegram?: { buttons?: unknown } } | undefined)
            ?.telegram?.buttons as any,
        }),
    ),
  };
  const api = {
    id: "test-plugin",
    config: {},
    pluginConfig: {
      enabled: true,
      defaultWorkspaceDir: "/repo/openclaw",
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    runtime: {
      state: {
        resolveStateDir: () => stateDir,
      },
      channel: {
        bindings: {
          bind: vi.fn(async () => ({})),
          unbind: vi.fn(async () => []),
          listBySession: vi.fn(() => []),
          resolveByConversation: vi.fn(() => null),
        },
        text: {
          chunkText: (text: string) => [text],
          resolveTextChunkLimit: (_cfg: unknown, _provider?: string, _accountId?: string | null, opts?: { fallbackLimit?: number }) =>
            opts?.fallbackLimit ?? 2000,
        },
        outbound: {
          loadAdapter: vi.fn(async (channel: string) => (channel === "telegram" ? telegramOutbound : undefined)),
        },
        telegram: {
          sendMessageTelegram,
          resolveTelegramToken,
          typing: {
            start: vi.fn(async () => ({ refresh: vi.fn(async () => {}), stop: vi.fn() })),
          },
          conversationActions: {
            renameTopic,
          },
        },
        discord: {
          sendMessageDiscord,
          sendComponentMessage,
          typing: {
            start: discordTypingStart,
          },
          conversationActions: {
            editChannel,
          },
        },
      },
    },
    registerService: vi.fn(),
    registerInteractiveHandler: vi.fn(),
    onConversationBindingResolved: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn(),
  } as unknown as OpenClawPluginApi;
  return {
    api,
    sendComponentMessage,
    sendMessageDiscord,
    sendMessageTelegram,
    telegramOutbound,
    discordTypingStart,
    renameTopic,
    resolveTelegramToken,
    editChannel,
    stateDir,
  };
}

async function createControllerHarness() {
  const {
    api,
    sendComponentMessage,
    sendMessageDiscord,
    sendMessageTelegram,
    discordTypingStart,
    renameTopic,
    resolveTelegramToken,
    editChannel,
    stateDir,
  } = createApiMock();
  const controller = new CodexPluginController(api);
  await controller.start();
  const threadState: any = {
    threadId: "thread-1",
    threadName: "Discord Thread",
    model: "openai/gpt-5.4",
    cwd: "/repo/openclaw",
    serviceTier: "default",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  };
  const clientMock = {
    hasProfile: vi.fn((profile: string) => profile === "default" || profile === "full-access"),
    listThreads: vi.fn(async () => [
      {
        threadId: "thread-1",
        title: "Discord Thread",
        projectKey: "/repo/openclaw",
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 30_000,
      },
    ]),
    startThread: vi.fn(async () => ({
      threadId: "thread-new",
      threadName: "New Thread",
      model: "openai/gpt-5.4",
      cwd: "/repo/openclaw",
      serviceTier: "default",
    })),
    listModels: vi.fn(async () => [
      { id: "openai/gpt-5.4", current: true },
      { id: "openai/gpt-5.3" },
    ]),
    listSkills: vi.fn(async () => [
      { name: "skill-a", description: "Skill A", cwd: "/repo/openclaw" },
      { name: "skill-b", description: "Skill B", cwd: "/repo/openclaw" },
    ]),
    listMcpServers: vi.fn(async () => []),
    readThreadState: vi.fn(async () => ({ ...threadState })),
    readThreadContext: vi.fn(async () => ({
      lastUserMessage: undefined,
      lastAssistantMessage: undefined,
    })),
    setThreadName: vi.fn(async () => ({
      threadId: "thread-1",
      threadName: "Discord Thread",
    })),
    setThreadModel: vi.fn(async (params: { model: string }) => {
      threadState.model = params.model;
      return { ...threadState };
    }),
    setThreadServiceTier: vi.fn(async (params: { serviceTier: string | null }) => {
      threadState.serviceTier = params.serviceTier ?? "default";
      return { ...threadState };
    }),
    setThreadPermissions: vi.fn(async (params: { approvalPolicy: string; sandbox: string }) => {
      threadState.approvalPolicy = params.approvalPolicy;
      threadState.sandbox = params.sandbox;
      return { ...threadState };
    }),
    startReview: vi.fn(() => ({
      result: new Promise(() => {}),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => false),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    })),
    readAccount: vi.fn(async () => ({
      email: "test@example.com",
      planType: "pro",
      type: "chatgpt",
    })),
    readRateLimits: vi.fn(async () => []),
  };
  (controller as any).client = clientMock;
  (controller as any).readThreadHasChanges = vi.fn(async () => false);
  return {
    controller,
    api,
    clientMock,
    sendComponentMessage,
    sendMessageDiscord,
    sendMessageTelegram,
    discordTypingStart,
    renameTopic,
    resolveTelegramToken,
    editChannel,
    stateDir,
  };
}

async function createControllerHarnessWithoutLegacyBindings() {
  const harness = createApiMock();
  delete (harness.api as any).runtime.channel.bindings;
  const controller = new CodexPluginController(harness.api);
  await controller.start();
  return {
    controller,
    api: harness.api,
  };
}

async function createControllerHarnessWithoutTelegramOutbound() {
  const harness = createApiMock();
  delete (harness.api as any).runtime.channel.outbound;
  const controller = new CodexPluginController(harness.api);
  await controller.start();
  const clientMock = {
    readThreadState: vi.fn(async () => ({
      threadId: "thread-1",
      threadName: "Discord Thread",
      model: "openai/gpt-5.4",
      cwd: "/repo/openclaw",
      serviceTier: "default",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    })),
    readThreadContext: vi.fn(async () => ({
      lastUserMessage: undefined,
      lastAssistantMessage: undefined,
    })),
    readAccount: vi.fn(async () => ({
      email: "test@example.com",
      planType: "pro",
      type: "chatgpt",
    })),
    readRateLimits: vi.fn(async () => []),
  };
  (controller as any).client = clientMock;
  (controller as any).readThreadHasChanges = vi.fn(async () => false);
  return {
    controller,
    sendMessageTelegram: harness.sendMessageTelegram,
  };
}

async function createControllerHarnessWithoutTelegramPayloadSupport() {
  const harness = createApiMock();
  (harness.api as any).runtime.channel.outbound.loadAdapter = vi.fn(async (channel: string) =>
    channel === "telegram"
      ? {
          sendText: harness.telegramOutbound.sendText,
          sendMedia: harness.telegramOutbound.sendMedia,
        }
      : undefined,
  );
  const controller = new CodexPluginController(harness.api);
  await controller.start();
  const clientMock = {
    readThreadState: vi.fn(async () => ({
      threadId: "thread-1",
      threadName: "Discord Thread",
      model: "openai/gpt-5.4",
      cwd: "/repo/openclaw",
      serviceTier: "default",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    })),
    readThreadContext: vi.fn(async () => ({
      lastUserMessage: undefined,
      lastAssistantMessage: undefined,
    })),
    readAccount: vi.fn(async () => ({
      email: "test@example.com",
      planType: "pro",
      type: "chatgpt",
    })),
    readRateLimits: vi.fn(async () => []),
  };
  (controller as any).client = clientMock;
  (controller as any).readThreadHasChanges = vi.fn(async () => false);
  return {
    controller,
    api: harness.api,
    sendMessageTelegram: harness.sendMessageTelegram,
  };
}

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: string };
const TEST_PLUGIN_VERSION = packageJson.version ?? "unknown";

function buildDiscordCommandContext(
  overrides: Partial<PluginCommandContext> & Record<string, unknown> = {},
): PluginCommandContext {
  return {
    senderId: "user-1",
    channel: "discord",
    channelId: "discord",
    isAuthorizedSender: true,
    args: "",
    commandBody: "/cas_resume",
    config: {},
    from: "discord:channel:chan-1",
    to: "slash:user-1",
    accountId: "default",
    requestConversationBinding: vi.fn(async () => ({ status: "bound" as const })),
    detachConversationBinding: vi.fn(async () => ({ removed: true })),
    getCurrentConversationBinding: vi.fn(async () => null),
    ...overrides,
  } as unknown as PluginCommandContext;
}

function buildTelegramCommandContext(
  overrides: Partial<PluginCommandContext> & Record<string, unknown> = {},
): PluginCommandContext {
  return {
    senderId: "user-1",
    channel: "telegram",
    channelId: "telegram",
    isAuthorizedSender: true,
    args: "",
    commandBody: "/cas_status",
    config: {},
    from: "telegram:123",
    to: "telegram:123",
    accountId: "default",
    requestConversationBinding: vi.fn(async () => ({ status: "bound" as const })),
    detachConversationBinding: vi.fn(async () => ({ removed: true })),
    getCurrentConversationBinding: vi.fn(async () => null),
    ...overrides,
  } as unknown as PluginCommandContext;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  discordSdkState.buildDiscordComponentMessage.mockClear();
  discordSdkState.editDiscordComponentMessage.mockClear();
  discordSdkState.registerBuiltDiscordComponentMessage.mockClear();
  discordSdkState.resolveDiscordAccount.mockClear();
  vi.spyOn(CodexAppServerClient.prototype, "logStartupProbe").mockResolvedValue();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "",
    })),
  );
});

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Discord controller flows", () => {
  it("starts cleanly without the legacy runtime.channel.bindings surface", async () => {
    const { controller } = await createControllerHarnessWithoutLegacyBindings();

    expect(controller).toBeInstanceOf(CodexPluginController);
  });

  it("stops the shared app-server client and interrupts active runs on service stop", async () => {
    const { controller } = await createControllerHarness();
    const interrupt = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    (controller as any).client.close = close;
    (controller as any).activeRuns.set("discord::default::channel:chan-1::", {
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      workspaceDir: "/repo/openclaw",
      mode: "default",
      handle: {
        result: Promise.resolve({ threadId: "thread-1", aborted: true }),
        queueMessage: vi.fn(async () => false),
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
        interrupt,
        isAwaitingInput: vi.fn(() => false),
        getThreadId: vi.fn(() => "thread-1"),
      },
    });

    await controller.stop();

    expect(interrupt).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect((controller as any).activeRuns.size).toBe(0);
  });

  it("uses the real Discord conversation target for slash-command resume pickers", async () => {
    const { controller, sendComponentMessage } = await createControllerHarness();

    const reply = await controller.handleCommand("cas_resume", buildDiscordCommandContext());

    expect(reply).toEqual({
      text: "Sent a Codex thread picker to this Discord conversation.",
    });
    expect(sendComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      expect.objectContaining({
        text: expect.stringContaining("Showing recent Codex threads"),
      }),
      expect.objectContaining({
        accountId: "default",
      }),
    );
  });

  it("renders structured help text for representative commands via handleCommand", async () => {
    const { controller } = await createControllerHarness();

    const fastHelp = await controller.handleCommand("cas_fast", buildDiscordCommandContext({
      args: "help",
      commandBody: "/cas_fast help",
    }));
    const resumeHelp = await controller.handleCommand("cas_resume", buildDiscordCommandContext({
      args: "--help",
      commandBody: "/cas_resume --help",
    }));
    const renameHelp = await controller.handleCommand("cas_rename", buildDiscordCommandContext({
      args: "help",
      commandBody: "/cas_rename help",
    }));

    expect(fastHelp.text).toContain("/cas_fast");
    expect(fastHelp.text).toContain("Usage:");
    expect(fastHelp.text).toContain("Examples:");
    expect(resumeHelp.text).toContain("/cas_resume");
    expect(resumeHelp.text).toContain("Flags/Args:");
    expect(renameHelp.text).toContain("/cas_rename");
    expect(renameHelp.text).toContain("Usage:");
  });

  it("renders help when Telegram-style em dash is used for --help", async () => {
    const { controller } = await createControllerHarness();

    const resumeHelp = await controller.handleCommand("cas_resume", buildDiscordCommandContext({
      args: "—help",
      commandBody: "/cas_resume —help",
    }));
    const statusHelp = await controller.handleCommand("cas_status", buildDiscordCommandContext({
      args: "—help",
      commandBody: "/cas_status —help",
    }));

    expect(resumeHelp.text).toContain("/cas_resume");
    expect(resumeHelp.text).toContain("Usage:");
    expect(statusHelp.text).toContain("/cas_status");
    expect(statusHelp.text).toContain("--yolo, --no-yolo");
  });

  it("keeps usage error paths for cas_fast, cas_steer, and cas_plan", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });

    const fastUsage = await controller.handleCommand("cas_fast", buildDiscordCommandContext({
      args: "nope",
      commandBody: "/cas_fast nope",
      getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
    }));
    const steerUsage = await controller.handleCommand("cas_steer", buildDiscordCommandContext({
      args: "",
      commandBody: "/cas_steer",
    }));
    const planUsage = await controller.handleCommand("cas_plan", buildDiscordCommandContext({
      args: "",
      commandBody: "/cas_plan",
    }));

    expect(fastUsage).toEqual({ text: "Usage: /cas_fast [on|off|status]" });
    expect(steerUsage).toEqual({ text: "Usage: /cas_steer <message>" });
    expect(planUsage).toEqual({ text: "Usage: /cas_plan <goal> | /cas_plan off" });
  });

  it("offers a New button on /cas_resume and flips into the new-thread project picker", async () => {
    const { controller } = await createControllerHarness();

    const reply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        commandBody: "/cas_resume",
      }),
    );

    const buttons = (reply.channelData as any)?.telegram?.buttons;
    expect(buttons?.flat().some((button: { text: string }) => button.text === "Projects")).toBe(true);
    expect(buttons?.flat().some((button: { text: string }) => button.text === "Browse Projects")).toBe(false);
    const newButton = buttons?.flat().find((button: { text: string }) => button.text === "New");
    expect(newButton?.callback_data).toBeTruthy();
    const token = (newButton?.callback_data as string).split(":").pop() ?? "";
    const callback = (controller as any).store.getCallback(token);
    expect(callback).toEqual(expect.objectContaining({
      kind: "picker-view",
      view: expect.objectContaining({
        mode: "projects",
        action: "start-new-thread",
      }),
    }));

    const editMessage = vi.fn(async (_payload: any) => {});
    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123:topic:456",
      parentConversationId: "123",
      threadId: 456,
      callback: {
        payload: token,
      },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    expect(editMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Choose a project for the new Codex thread"),
      buttons: expect.arrayContaining([
        expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining("openclaw"),
          }),
        ]),
        expect.arrayContaining([
          expect.objectContaining({
            text: "Recent Threads",
          }),
        ]),
      ]),
    }));
  });

  it("starts a new thread directly for /cas_resume --new without args in the default workspace", async () => {
    const { controller, clientMock } = await createControllerHarness();
    const requestConversationBinding = vi.fn(async () => ({ status: "bound" as const }));

    const reply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "--new",
        commandBody: "/cas_resume --new",
        requestConversationBinding,
      }),
    );

    expect(reply).toEqual({});
    expect(clientMock.startThread).toHaveBeenCalledWith({
      profile: "default",
      sessionKey: undefined,
      workspaceDir: "/repo/openclaw",
      model: undefined,
    });
    expect(requestConversationBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.stringContaining("Bind this conversation to Codex thread"),
      }),
    );
  });

  it("starts a new full-access thread directly for /cas_resume --new --yolo", async () => {
    const { controller, clientMock } = await createControllerHarness();
    const requestConversationBinding = vi.fn(async () => ({ status: "bound" as const }));

    const reply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "--new --yolo",
        commandBody: "/cas_resume --new --yolo",
        requestConversationBinding,
      }),
    );

    expect(reply).toEqual({});
    expect(clientMock.startThread).toHaveBeenCalledWith({
      profile: "full-access",
      sessionKey: undefined,
      workspaceDir: "/repo/openclaw",
      model: undefined,
    });
    expect(requestConversationBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.stringContaining("Bind this conversation to Codex thread"),
      }),
    );
  });

  it("collapses matching worktrees to one project root in the /cas_resume --new picker", async () => {
    const { controller } = await createControllerHarness();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-worktree-picker-"));
    const canonicalWorkspaceDir = path.join(tempRoot, "github", "openclaw");
    const worktreeA = path.join(tempRoot, ".codex", "worktrees", "7d9d", "openclaw");
    const worktreeB = path.join(tempRoot, ".codex", "worktrees", "1999", "openclaw");
    fs.mkdirSync(canonicalWorkspaceDir, { recursive: true });
    fs.mkdirSync(worktreeA, { recursive: true });
    fs.mkdirSync(worktreeB, { recursive: true });

    (controller as any).client.listThreads.mockResolvedValue([
      {
        threadId: "thread-a",
        title: "Feature A",
        projectKey: worktreeA,
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 30_000,
      },
      {
        threadId: "thread-b",
        title: "Feature B",
        projectKey: worktreeB,
        createdAt: Date.now() - 50_000,
        updatedAt: Date.now() - 20_000,
      },
    ]);
    (controller as any).resolveProjectFolder = vi.fn(async (workspaceDir?: string) => {
      const normalized = workspaceDir?.replace(/\\/g, "/");
      if (!normalized?.includes("/.codex/worktrees/")) {
        return workspaceDir;
      }
      return canonicalWorkspaceDir;
    });

    const reply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "--new --projects",
        commandBody: "/cas_resume --new --projects",
      }),
    );

    expect(reply.text).toContain("Choose a project for the new Codex thread");
    const buttons = (reply.channelData as any)?.telegram?.buttons;
    expect(buttons?.[0]?.[0]?.text).toBe("openclaw (2)");
    const callbackData = buttons?.[0]?.[0]?.callback_data as string;
    const token = callbackData.split(":").pop() ?? "";
    expect((controller as any).store.getCallback(token)).toEqual(expect.objectContaining({
      kind: "start-new-thread",
      workspaceDir: canonicalWorkspaceDir,
    }));
  });

  it("ignores removed worktree history when the project root still exists in the /cas_resume --new picker", async () => {
    const { controller } = await createControllerHarness();
    const canonicalWorkspaceParent = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-root-"));
    const canonicalWorkspaceDir = path.join(canonicalWorkspaceParent, "openclaw");
    fs.mkdirSync(canonicalWorkspaceDir);

    (controller as any).client.listThreads.mockResolvedValue([
      {
        threadId: "thread-root",
        title: "Main Root",
        projectKey: canonicalWorkspaceDir,
        createdAt: Date.now() - 70_000,
        updatedAt: Date.now() - 10_000,
      },
      {
        threadId: "thread-stale-a",
        title: "Removed Worktree A",
        projectKey: path.join(canonicalWorkspaceParent, "worktrees/fd73/openclaw"),
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 30_000,
      },
      {
        threadId: "thread-stale-b",
        title: "Removed Worktree B",
        projectKey: path.join(canonicalWorkspaceParent, "worktrees/80de/openclaw"),
        createdAt: Date.now() - 50_000,
        updatedAt: Date.now() - 20_000,
      },
    ]);

    const reply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "--new --projects",
        commandBody: "/cas_resume --new --projects",
      }),
    );

    expect(reply.text).toContain("Choose a project for the new Codex thread");
    const buttons = (reply.channelData as any)?.telegram?.buttons;
    expect(buttons?.[0]?.[0]?.text).toBe("openclaw (3)");
    const callbackData = buttons?.[0]?.[0]?.callback_data as string;
    const token = callbackData.split(":").pop() ?? "";
    expect((controller as any).store.getCallback(token)).toEqual(expect.objectContaining({
      kind: "start-new-thread",
      workspaceDir: canonicalWorkspaceDir,
    }));
  });

  it("starts a new thread directly for /cas_resume --new <project>", async () => {
    const { controller, clientMock } = await createControllerHarness();
    const requestConversationBinding = vi.fn(async () => ({ status: "bound" as const }));

    const reply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "--new openclaw",
        commandBody: "/cas_resume --new openclaw",
        requestConversationBinding,
      }),
    );

    expect(reply).toEqual({});
    expect(clientMock.startThread).toHaveBeenCalledWith({
      profile: "default",
      sessionKey: undefined,
      workspaceDir: "/repo/openclaw",
      model: undefined,
    });
    expect(requestConversationBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.stringContaining("Bind this conversation to Codex thread"),
      }),
    );
  });

  it("keeps grouped project names in the /cas_resume --new picker and disambiguates after selection", async () => {
    const { controller, clientMock } = await createControllerHarness();
    clientMock.listThreads.mockResolvedValue([
      {
        threadId: "thread-a",
        title: "Customer A",
        projectKey: "/work/customer-a/app",
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 30_000,
      },
      {
        threadId: "thread-b",
        title: "Customer B",
        projectKey: "/work/customer-b/app",
        createdAt: Date.now() - 50_000,
        updatedAt: Date.now() - 20_000,
      },
    ]);

    const reply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "--new app",
        commandBody: "/cas_resume --new app",
      }),
    );

    expect(clientMock.startThread).not.toHaveBeenCalled();
    const buttons = (reply.channelData as any)?.telegram?.buttons;
    expect(buttons?.[0]?.[0]?.text).toBe("app (2)");
    const token = (buttons?.[0]?.[0]?.callback_data as string).split(":").pop() ?? "";
    expect((controller as any).store.getCallback(token)).toEqual(expect.objectContaining({
      kind: "picker-view",
      view: expect.objectContaining({
        mode: "workspaces",
        projectName: "app",
      }),
    }));

    const editMessage = vi.fn(async (_payload: any) => {});
    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123:topic:456",
      parentConversationId: "123",
      threadId: 456,
      callback: {
        payload: token,
      },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    expect(editMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Multiple workspaces matched app"),
      buttons: expect.arrayContaining([
        expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining("/work/customer-b/app"),
          }),
        ]),
        expect.arrayContaining([
          expect.objectContaining({
            text: "Projects",
          }),
          expect.objectContaining({
            text: "Recent Threads",
          }),
        ]),
      ]),
    }));
  });

  it("expands home-relative paths for /cas_resume --new positional workspace args", async () => {
    const { controller, clientMock } = await createControllerHarness();
    const requestConversationBinding = vi.fn(async () => ({ status: "bound" as const }));

    const reply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "--new ~/github/openclaw",
        commandBody: "/cas_resume --new ~/github/openclaw",
        requestConversationBinding,
      }),
    );

    expect(reply).toEqual({});
    expect(clientMock.startThread).toHaveBeenCalledWith({
      profile: "default",
      sessionKey: undefined,
      workspaceDir: path.join(os.homedir(), "github/openclaw"),
      model: undefined,
    });
  });

  it("rejects resume when the thread worktree path no longer exists on disk", async () => {
    const { controller, clientMock } = await createControllerHarness();
    const missingWorktreePath = "/tmp/worktrees/bold-bartik/repo-name";
    clientMock.listThreads.mockResolvedValue([
      {
        threadId: "thread-stale",
        title: "Stale Worktree Thread",
        projectKey: missingWorktreePath,
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 30_000,
      },
    ]);
    clientMock.readThreadState.mockResolvedValue({
      threadId: "thread-stale",
      threadName: "Stale Worktree Thread",
      model: "openai/gpt-5.4",
      cwd: missingWorktreePath,
      serviceTier: "default",
    });

    const reply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "thread-stale",
        commandBody: "/cas_resume thread-stale",
      }),
    );

    expect(reply.text).toContain("Cannot resume");
    expect(reply.text).toContain(missingWorktreePath);
    expect(reply.text).toContain("no longer exists on disk");
  });

  it("applies model, fast, and yolo flags when resuming a thread", async () => {
    const { controller } = await createControllerHarness();

    const reply = await controller.handleCommand(
      "cas_resume",
      buildDiscordCommandContext({
        args: "thread-1 --model gpt-5.4 --fast --yolo",
        commandBody: "/cas_resume thread-1 --model gpt-5.4 --fast --yolo",
      }),
    );

    expect(reply).toEqual({});
    const binding = (controller as any).store.getBinding({
      channel: "discord",
      accountId: "default",
      conversationId: "channel:chan-1",
    });
    expect(binding?.permissionsMode).toBe("full-access");
    expect(binding?.preferences?.preferredModel).toBe("gpt-5.4");
    expect(binding?.preferences?.preferredServiceTier).toBe("fast");
  });

  it("applies em-dash model, fast, and yolo flags when resuming a thread", async () => {
    const { controller } = await createControllerHarness();

    const reply = await controller.handleCommand(
      "cas_resume",
      buildDiscordCommandContext({
        args: "thread-1 —model gpt-5.4 —fast —yolo",
        commandBody: "/cas_resume thread-1 —model gpt-5.4 —fast —yolo",
      }),
    );

    expect(reply).toEqual({});
    const binding = (controller as any).store.getBinding({
      channel: "discord",
      accountId: "default",
      conversationId: "channel:chan-1",
    });
    expect(binding?.permissionsMode).toBe("full-access");
    expect(binding?.preferences?.preferredModel).toBe("gpt-5.4");
    expect(binding?.preferences?.preferredServiceTier).toBe("fast");
  });

  it("preserves em-dash resume overrides through the no-query picker callback", async () => {
    const { controller } = await createControllerHarness();

    const reply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "—model gpt-5.3-codex-spark —yolo",
        commandBody: "/cas_resume —model gpt-5.3-codex-spark —yolo",
      }),
    );

    const buttons = (reply.channelData as any)?.telegram?.buttons;
    const callbackData = buttons?.[0]?.[0]?.callback_data as string | undefined;
    expect(callbackData).toMatch(/^codexapp:/);

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callbackData?.slice("codexapp:".length) },
      requestConversationBinding: vi.fn(async () => ({ status: "bound" as const })),
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
      },
    } as any);

    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.permissionsMode).toBe("full-access");
    expect(binding?.preferences?.preferredModel).toBe("gpt-5.3-codex-spark");
  });

  it("resolves channel identity from ctx.to when ctx.from is a slash identity in a new Discord thread", async () => {
    // Regression test for brand-new Discord threads where the slash interaction
    // places the slash user identity in ctx.from and the channel target in ctx.to.
    const { controller, sendComponentMessage } = await createControllerHarness();

    const reply = await controller.handleCommand(
      "cas_resume",
      buildDiscordCommandContext({
        from: "slash:user-1",
        to: "discord:channel:chan-1",
      }),
    );

    expect(reply).toEqual({
      text: "Sent a Codex thread picker to this Discord conversation.",
    });
    expect(sendComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      expect.objectContaining({
        text: expect.stringContaining("Showing recent Codex threads"),
      }),
      expect.objectContaining({
        accountId: "default",
      }),
    );
  });

  it("sends Discord skills directly instead of returning Telegram buttons", async () => {
    const { controller, sendComponentMessage } = await createControllerHarness();

    const reply = await controller.handleCommand("cas_skills", buildDiscordCommandContext({
      commandBody: "/cas_skills",
    }));

    expect(reply).toEqual({
      text: "Sent Codex skills to this Discord conversation.",
    });
    expect(sendComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      expect.objectContaining({
        text: expect.stringContaining("Type `$skill-name` in this chat to run one directly."),
        blocks: expect.arrayContaining([
          expect.objectContaining({
            buttons: expect.arrayContaining([
              expect.objectContaining({ label: "$skill-a" }),
              expect.objectContaining({ label: "$skill-b" }),
            ]),
          }),
          expect.objectContaining({
            buttons: expect.arrayContaining([
              expect.objectContaining({ label: "Mode: toggle" }),
              expect.objectContaining({ label: "Cancel" }),
            ]),
          }),
        ]),
      }),
      expect.objectContaining({ accountId: "default" }),
    );
  });

  it("deduplicates skills with the same name in the skills picker", async () => {
    const { controller, clientMock } = await createControllerHarness();
    clientMock.listSkills.mockResolvedValueOnce([
      { name: "last30days", description: "Variant A", cwd: "/repo/openclaw" },
      { name: "last30days", description: "Variant B", cwd: "/repo/openclaw" },
      { name: "agent-browser", description: "Browser", cwd: "/repo/openclaw" },
    ]);

    const picker = await (controller as any).buildSkillsPicker(
      {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      null,
      {
        page: 0,
        clickMode: "run",
      },
    );

    const labels = (picker.buttons as Array<Array<{ text: string }>> | undefined)
      ?.flat()
      .map((button) => button.text) ?? [];
    expect(labels.filter((label) => label === "$last30days")).toHaveLength(1);
    expect(labels).toEqual(expect.arrayContaining(["$last30days", "$agent-browser"]));
  });

  it("refreshes Discord pickers by editing the original interaction message", async () => {
    const { controller, sendComponentMessage } = await createControllerHarness();
    const callback = await (controller as any).store.putCallback({
      kind: "picker-view",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      view: {
        mode: "threads",
        includeAll: true,
        page: 0,
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleDiscordInteractive({
      channel: "discord",
      accountId: "default",
      interactionId: "interaction-1",
      conversationId: "channel:chan-1",
      auth: { isAuthorizedSender: true },
      interaction: {
        kind: "button",
        data: `codexapp:${callback.token}`,
        namespace: "codexapp",
        payload: callback.token,
        messageId: "message-1",
      },
      senderId: "user-1",
      senderUsername: "Ada",
      respond: {
        acknowledge: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        followUp: vi.fn(async () => {}),
        editMessage,
        clearComponents: vi.fn(async () => {}),
      },
    } as any);

    expect(editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        components: expect.any(Array),
      }),
    );
    expect(discordSdkState.registerBuiltDiscordComponentMessage).toHaveBeenCalledWith({
      buildResult: expect.objectContaining({
        components: expect.any(Array),
        entries: expect.any(Array),
      }),
      messageId: "message-1",
    });
    expect(discordSdkState.editDiscordComponentMessage).not.toHaveBeenCalled();
    expect(sendComponentMessage).not.toHaveBeenCalled();
  });

  it("refreshes the Discord project picker by editing the interaction message", async () => {
    const { controller, sendComponentMessage } = await createControllerHarness();
    const callback = await (controller as any).store.putCallback({
      kind: "picker-view",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      view: {
        mode: "projects",
        includeAll: true,
        page: 0,
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleDiscordInteractive({
      channel: "discord",
      accountId: "default",
      interactionId: "interaction-1",
      conversationId: "channel:chan-1",
      auth: { isAuthorizedSender: true },
      interaction: {
        kind: "button",
        data: `codexapp:${callback.token}`,
        namespace: "codexapp",
        payload: callback.token,
        messageId: "message-1",
      },
      senderId: "user-1",
      senderUsername: "Ada",
      respond: {
        acknowledge: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        followUp: vi.fn(async () => {}),
        editMessage,
        clearComponents: vi.fn(async () => {}),
      },
    } as any);

    expect(editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        components: expect.any(Array),
      }),
    );
    expect(discordSdkState.registerBuiltDiscordComponentMessage).toHaveBeenCalledWith({
      buildResult: expect.objectContaining({
        components: expect.any(Array),
        entries: expect.any(Array),
      }),
      messageId: "message-1",
    });
    expect(discordSdkState.editDiscordComponentMessage).not.toHaveBeenCalled();
    expect(sendComponentMessage).not.toHaveBeenCalled();
  });

  it("falls back to direct Discord message edit when the interaction was already acknowledged", async () => {
    const { controller, sendComponentMessage } = await createControllerHarness();
    const callback = await (controller as any).store.putCallback({
      kind: "picker-view",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      view: {
        mode: "projects",
        includeAll: true,
        page: 0,
      },
    });
    const acknowledge = vi.fn(async () => {});
    const editMessage = vi.fn(async () => {
      throw new Error("Interaction has already been acknowledged.");
    });

    await controller.handleDiscordInteractive({
      channel: "discord",
      accountId: "default",
      interactionId: "interaction-1",
      conversationId: "channel:chan-1",
      auth: { isAuthorizedSender: true },
      interaction: {
        kind: "button",
        data: `codexapp:${callback.token}`,
        namespace: "codexapp",
        payload: callback.token,
        messageId: "message-1",
      },
      senderId: "user-1",
      senderUsername: "Ada",
      respond: {
        acknowledge,
        reply: vi.fn(async () => {}),
        followUp: vi.fn(async () => {}),
        editMessage,
        clearComponents: vi.fn(async () => {}),
      },
    } as any);

    expect(editMessage).toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
    expect(discordSdkState.registerBuiltDiscordComponentMessage).not.toHaveBeenCalled();
    expect(discordSdkState.editDiscordComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      "message-1",
      expect.objectContaining({
        text: expect.stringContaining("Choose a project to filter recent Codex threads"),
      }),
      expect.objectContaining({ accountId: "default" }),
    );
    expect(sendComponentMessage).not.toHaveBeenCalled();
  });

  it("acknowledges and clears Discord pending-input buttons by message id", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertPendingRequest({
      requestId: "pending-1",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      state: {
        requestId: "pending-1",
        options: ["Approve Once", "Cancel"],
        expiresAt: Date.now() + 60_000,
      },
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "pending-input",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      requestId: "pending-1",
      actionIndex: 0,
    });
    const acknowledge = vi.fn(async () => {});
    const clearComponents = vi.fn(async () => {});
    const reply = vi.fn(async () => {});
    const followUp = vi.fn(async () => {});
    const submitPendingInput = vi.fn(async () => true);
    (controller as any).activeRuns.set("discord::default::channel:chan-1::", {
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      workspaceDir: "/repo/openclaw",
      mode: "default",
      handle: {
        result: Promise.resolve({ threadId: "thread-1", text: "done" }),
        queueMessage: vi.fn(async () => false),
        submitPendingInput,
        submitPendingInputPayload: vi.fn(async () => false),
        interrupt: vi.fn(async () => {}),
        isAwaitingInput: vi.fn(() => true),
        getThreadId: vi.fn(() => "thread-1"),
      },
    });

    await controller.handleDiscordInteractive({
      channel: "discord",
      accountId: "default",
      interactionId: "interaction-1",
      conversationId: "channel:chan-1",
      auth: { isAuthorizedSender: true },
      interaction: {
        kind: "button",
        data: `codexapp:${callback.token}`,
        namespace: "codexapp",
        payload: callback.token,
        messageId: "message-1",
      },
      senderId: "user-1",
      senderUsername: "Ada",
      respond: {
        acknowledge,
        reply,
        followUp,
        editMessage: vi.fn(async () => {}),
        clearComponents,
      },
    } as any);

    expect(submitPendingInput).toHaveBeenCalledWith(0);
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(clearComponents).not.toHaveBeenCalled();
    expect(discordSdkState.editDiscordComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      "message-1",
      {
        text: "Sent to Codex.",
      },
      expect.objectContaining({ accountId: "default" }),
    );
    expect(reply).not.toHaveBeenCalled();
    expect(followUp).not.toHaveBeenCalled();
  });

  it("does not send a second Discord response after completing a questionnaire", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertPendingRequest({
      requestId: "questionnaire-1",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      state: {
        requestId: "questionnaire-1",
        options: [],
        expiresAt: Date.now() + 60_000,
        questionnaire: {
          currentIndex: 1,
          awaitingFreeform: false,
          questions: [
            {
              index: 0,
              id: "milk",
              header: "Milk",
              prompt: "Do you like milk on cereal?",
              options: [
                { key: "A", label: "Yes", description: "Sure." },
                { key: "B", label: "No", description: "Nope." },
              ],
            },
            {
              index: 1,
              id: "type",
              header: "Type",
              prompt: "What kind of milk?",
              options: [
                { key: "A", label: "Whole", description: "Richer." },
                { key: "B", label: "2%", description: "Lighter." },
              ],
            },
          ],
          answers: [
            {
              kind: "option",
              optionKey: "A",
              optionLabel: "Yes",
            },
            null,
          ],
        },
      },
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "pending-questionnaire",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      requestId: "questionnaire-1",
      questionIndex: 1,
      action: "select",
      optionIndex: 0,
    });
    const acknowledge = vi.fn(async () => {});
    const clearComponents = vi.fn(async () => {});
    const reply = vi.fn(async () => {});
    const followUp = vi.fn(async () => {});
    const submitPendingInputPayload = vi.fn(async () => true);
    (controller as any).activeRuns.set("discord::default::channel:chan-1::", {
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      workspaceDir: "/repo/openclaw",
      mode: "plan",
      handle: {
        result: Promise.resolve({ threadId: "thread-1", text: "done" }),
        queueMessage: vi.fn(async () => false),
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload,
        interrupt: vi.fn(async () => {}),
        isAwaitingInput: vi.fn(() => true),
        getThreadId: vi.fn(() => "thread-1"),
      },
    });

    await controller.handleDiscordInteractive({
      channel: "discord",
      accountId: "default",
      interactionId: "interaction-1",
      conversationId: "channel:chan-1",
      auth: { isAuthorizedSender: true },
      interaction: {
        kind: "button",
        data: `codexapp:${callback.token}`,
        namespace: "codexapp",
        payload: callback.token,
        messageId: "message-1",
      },
      senderId: "user-1",
      senderUsername: "Ada",
      respond: {
        acknowledge,
        reply,
        followUp,
        editMessage: vi.fn(async () => {}),
        clearComponents,
      },
    } as any);

    expect(submitPendingInputPayload).toHaveBeenCalledWith({
      answers: {
        milk: { answers: ["Yes"] },
        type: { answers: ["Whole"] },
      },
    });
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(clearComponents).not.toHaveBeenCalled();
    expect(discordSdkState.editDiscordComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      "message-1",
      {
        text: "Recorded your answers and sent them to Codex.",
      },
      expect.objectContaining({ accountId: "default" }),
    );
    expect((controller as any).store.getPendingRequestById("questionnaire-1")).toBeNull();
    expect(reply).not.toHaveBeenCalled();
    expect(followUp).not.toHaveBeenCalled();
  });

  it("clears stored Discord pending-questionnaire buttons when asked directly", async () => {
    const { controller } = await createControllerHarness();

    await (controller as any).clearPendingRequestMessage(
      {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      {
        requestId: "questionnaire-clear-1",
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:chan-1",
        },
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        pendingMessage: {
          provider: "discord",
          channelId: "channel:chan-1",
          messageId: "pending-message-1",
        },
        state: {
          requestId: "questionnaire-clear-1",
          options: [],
          expiresAt: Date.now() + 60_000,
          method: "item/tool/requestUserInput",
          questionnaire: {
            currentIndex: 0,
            questions: [
              {
                index: 0,
                id: "scope",
                header: "Scope",
                prompt: "Which path should Codex take?",
                options: [{ key: "A", label: "Safe", description: "Small prod-safe slice." }],
                guidance: [],
                allowFreeform: true,
              },
            ],
            answers: [null],
            responseMode: "structured",
          },
        },
        updatedAt: Date.now(),
      },
    );

    expect(discordSdkState.editDiscordComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      "pending-message-1",
      expect.objectContaining({ text: expect.stringContaining("Which path should Codex take?") }),
      expect.objectContaining({ accountId: "default" }),
    );
  });

  it("annotates delayed questionnaire replies so Codex can distinguish them from defaults", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T12:31:00-04:00"));
    try {
      const { controller } = await createControllerHarness();
      const createdAt = Date.now() - 52 * 60_000;
      await (controller as any).store.upsertPendingRequest({
        requestId: "questionnaire-2",
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:chan-1",
        },
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        state: {
          requestId: "questionnaire-2",
          options: [],
          expiresAt: Date.now() + 7 * 24 * 60 * 60_000,
          questionnaire: {
            currentIndex: 1,
            awaitingFreeform: false,
            questions: [
              {
                index: 0,
                id: "milk",
                header: "Milk",
                prompt: "Do you like milk on cereal?",
                options: [
                  { key: "A", label: "Cereal (Recommended)", description: "Default-looking choice." },
                  { key: "B", label: "Bagels", description: "Alternate choice." },
                ],
                guidance: [],
              },
              {
                index: 1,
                id: "type",
                header: "Type",
                prompt: "What kind of milk?",
                options: [
                  { key: "A", label: "Whole", description: "Richer." },
                  { key: "B", label: "2%", description: "Lighter." },
                ],
                guidance: [],
              },
            ],
            answers: [
              {
                kind: "option",
                optionKey: "A",
                optionLabel: "Cereal (Recommended)",
              },
              null,
            ],
            responseMode: "structured",
          },
        },
        createdAt,
        updatedAt: createdAt,
      });
      const callback = await (controller as any).store.putCallback({
        kind: "pending-questionnaire",
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:chan-1",
        },
        requestId: "questionnaire-2",
        questionIndex: 1,
        action: "select",
        optionIndex: 0,
      });
      const acknowledge = vi.fn(async () => {});
      const clearComponents = vi.fn(async () => {});
      const reply = vi.fn(async () => {});
      const followUp = vi.fn(async () => {});
      const submitPendingInputPayload = vi.fn(async () => true);
      (controller as any).activeRuns.set("discord::default::channel:chan-1::", {
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:chan-1",
        },
        workspaceDir: "/repo/openclaw",
        mode: "plan",
        handle: {
          result: Promise.resolve({ threadId: "thread-1", text: "done" }),
          queueMessage: vi.fn(async () => false),
          submitPendingInput: vi.fn(async () => false),
          submitPendingInputPayload,
          interrupt: vi.fn(async () => {}),
          isAwaitingInput: vi.fn(() => true),
          getThreadId: vi.fn(() => "thread-1"),
        },
      });

      await controller.handleDiscordInteractive({
        channel: "discord",
        accountId: "default",
        interactionId: "interaction-2",
        conversationId: "channel:chan-1",
        auth: { isAuthorizedSender: true },
        interaction: {
          kind: "button",
          data: `codexapp:${callback.token}`,
          namespace: "codexapp",
          payload: callback.token,
          messageId: "message-2",
        },
        senderId: "user-1",
        senderUsername: "Ada",
        respond: {
          acknowledge,
          reply,
          followUp,
          editMessage: vi.fn(async () => {}),
          clearComponents,
        },
      } as any);

      expect(submitPendingInputPayload).toHaveBeenCalledWith({
        answers: {
          milk: {
            answers: [
              "Cereal (Recommended)",
              "user_note: This answer was selected by the user in chat after 52 minutes; it was not auto-selected.",
            ],
          },
          type: { answers: ["Whole"] },
        },
      });
      expect(acknowledge).toHaveBeenCalledTimes(1);
      expect(clearComponents).not.toHaveBeenCalled();
      expect(reply).not.toHaveBeenCalled();
      expect(followUp).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("normalizes raw Discord callback conversation ids for guild interactions", async () => {
    const { controller, sendComponentMessage } = await createControllerHarness();
    const callback = await (controller as any).store.putCallback({
      kind: "picker-view",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      view: {
        mode: "projects",
        includeAll: true,
        page: 0,
      },
    });

    await controller.handleDiscordInteractive({
      channel: "discord",
      accountId: "default",
      interactionId: "interaction-1",
      conversationId: "1481858418548412579",
      guildId: "guild-1",
      auth: { isAuthorizedSender: true },
      interaction: {
        kind: "button",
        data: `codexapp:${callback.token}`,
        namespace: "codexapp",
        payload: callback.token,
        messageId: "message-1",
      },
      senderId: "user-1",
      senderUsername: "Ada",
      respond: {
        acknowledge: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        followUp: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
        clearComponents: vi.fn(async () => {
          throw new Error("Interaction has already been acknowledged.");
        }),
      },
    } as any);

    expect(sendComponentMessage).not.toHaveBeenCalled();
  });

  it("hydrates a pending approved binding when status is requested after core approval", async () => {
    const { controller, sendComponentMessage } = await createControllerHarness();
    await (controller as any).store.upsertPendingBind({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      threadTitle: "Discord Thread",
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand("cas_status", buildDiscordCommandContext({
      commandBody: "/cas_status",
      getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
    }));

    expect(reply).toEqual({
      text: "Sent Codex status controls to this Discord conversation.",
    });
    expect(sendComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      expect.objectContaining({
        text: expect.stringContaining("Binding: Discord Thread (openclaw)"),
      }),
      expect.objectContaining({ accountId: "default" }),
    );
    expect((controller as any).store.getBinding({
      channel: "discord",
      accountId: "default",
      conversationId: "channel:chan-1",
    })).toEqual(
      expect.objectContaining({
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
      }),
    );
  });

  it("shows cas_status as none when no core binding exists", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "user:1177378744822943744",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/discrawl",
      threadTitle: "Summarize tools used",
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_status",
      buildDiscordCommandContext({
        from: "discord:1177378744822943744",
        to: "slash:1177378744822943744",
        commandBody: "/cas_status",
        getCurrentConversationBinding: vi.fn(async () => null),
      }),
    );

    expect(reply.text).toContain("Binding: none");
    expect(reply.text).toContain("Topic is locally known but not core-bound; run /cas_resume.");
    expect(reply.text).toContain(`Plugin version: ${TEST_PLUGIN_VERSION}`);
    expect(reply.text).toContain("Project folder: /repo/discrawl");
    expect(reply.text).toContain("Thread: thread-1");
  });

  it("rejects cas_status overrides when the topic is only locally known", async () => {
    const { controller, clientMock } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      preferences: {
        preferredModel: "openai/gpt-5.4",
        preferredServiceTier: null,
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_status",
      buildTelegramCommandContext({
        args: "--model gpt-5.4 --fast --yolo",
        commandBody: "/cas_status --model gpt-5.4 --fast --yolo",
        getCurrentConversationBinding: vi.fn(async () => null),
      }),
    );

    expect(reply.text).toBe("Run /cas_resume before changing status settings for this topic.");
    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.permissionsMode).toBeUndefined();
    expect(binding?.preferences?.preferredServiceTier).toBeNull();
    expect(clientMock.setThreadModel).not.toHaveBeenCalled();
    expect(clientMock.setThreadServiceTier).not.toHaveBeenCalled();
  });

  it("does not hydrate a denied pending bind into cas_status", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertPendingBind({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/discrawl",
      threadTitle: "Summarize tools used",
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_status",
      buildTelegramCommandContext({
        commandBody: "/cas_status",
        getCurrentConversationBinding: vi.fn(async () => null),
      }),
    );

    expect(reply.text).toContain("Binding: none");
    expect(reply.text).not.toContain("Project folder: /repo/discrawl");
    expect((controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    })).toBeNull();
  });

  it("shows plan mode on in cas_status when the bound conversation has an active plan run", async () => {
    const { controller, sendComponentMessage } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      threadTitle: "Discord Thread",
      updatedAt: Date.now(),
    });
    (controller as any).activeRuns.set("discord::default::channel:chan-1::", {
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      workspaceDir: "/repo/openclaw",
      mode: "plan",
      handle: {
        result: Promise.resolve({ threadId: "thread-1", text: "planned" }),
        queueMessage: vi.fn(async () => true),
        getThreadId: () => "thread-1",
        interrupt: vi.fn(async () => {}),
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      },
    });

    const reply = await controller.handleCommand("cas_status", buildDiscordCommandContext({
      commandBody: "/cas_status",
      getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
    }));

    expect(reply).toEqual({
      text: "Sent Codex status controls to this Discord conversation.",
    });
    expect(sendComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      expect.objectContaining({
        text: expect.stringContaining("Binding: Discord Thread (openclaw)"),
      }),
      expect.objectContaining({ accountId: "default" }),
    );
    expect(sendComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      expect.objectContaining({
        text: expect.stringContaining("Plan mode: on"),
      }),
      expect.objectContaining({ accountId: "default" }),
    );
  });

  it("sends and pins status control buttons when a binding exists", async () => {
    const { controller, sendMessageTelegram } = await createControllerHarness();
    const fetchMock = vi.mocked(fetch);
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_status",
      buildTelegramCommandContext({
        commandBody: "/cas_status",
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
      }),
    );

    expect(reply).toEqual({});
    expect(sendMessageTelegram).toHaveBeenCalledTimes(1);
    const firstCall = sendMessageTelegram.mock.calls[0] as unknown as
      | [string, string, { buttons?: Array<Array<{ text: string; callback_data: string }>> }]
      | undefined;
    const buttons = firstCall?.[2]?.buttons ?? [];

    expect(buttons).toHaveLength(5);
    expect(buttons[0][0].text).toBe("Select Model");
    expect(buttons[0][1].text).toBe("Reasoning: Default");
    expect(buttons[1][0].text).toBe("Fast: toggle");
    expect(buttons[1][1].text).toBe("Permissions: toggle");
    expect(buttons[2][0].text).toBe("Compact");
    expect(buttons[2][1].text).toBe("Stop");
    expect(buttons[3][0].text).toBe("Refresh");
    expect(buttons[3][1].text).toBe("Detach");
    expect(buttons[4][0].text).toBe("Skills");
    expect(buttons[4][1].text).toBe("MCPs");
    const kinds = buttons.flatMap((row: Array<{ callback_data: string }>) => {
      return row.map((button) => {
        const token = button.callback_data.split(":").pop() ?? "";
        return (controller as any).store.getCallback(token)?.kind;
      });
    });
    expect(kinds).toEqual(
      expect.arrayContaining([
        "show-model-picker",
        "show-reasoning-picker",
        "toggle-fast",
        "toggle-permissions",
        "compact-thread",
        "stop-run",
        "refresh-status",
        "detach-thread",
        "show-skills",
        "show-mcp",
      ]),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("adds inline task controls to the status card for resumable work", async () => {
    const { controller, sendMessageTelegram } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      taskState: {
        goal: "Ship the long-lived cockpit flow",
        stage: "blocked",
        nextAction: "Resume from the last checkpoint",
        blocker: "Codex paused for approval",
        checkpoint: {
          summary: "Codex paused for approval",
          nextAction: "Review or approve the pending Codex action",
          savedAt: Date.now(),
        },
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_status",
      buildTelegramCommandContext({
        commandBody: "/cas_status",
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
      }),
    );

    expect(reply).toEqual({});
    const firstCall = sendMessageTelegram.mock.calls[0] as unknown as
      | [string, string, { buttons?: Array<Array<{ text: string; callback_data: string }>> }]
      | undefined;
    const buttonLabels = firstCall?.[2]?.buttons?.flat().map((button) => button.text) ?? [];
    expect(buttonLabels).toEqual(expect.arrayContaining(["Resume", "Mark verified", "Clear blocker"]));
    const kinds = (firstCall?.[2]?.buttons ?? []).flatMap((row: Array<{ callback_data: string }>) =>
      row.map((button) => {
        const token = button.callback_data.split(":").pop() ?? "";
        return (controller as any).store.getCallback(token)?.kind;
      }),
    );
    expect(kinds).toEqual(expect.arrayContaining(["resume-task", "mark-verified", "clear-task-blocker"]));
  });

  it("falls back to the legacy Telegram runtime when outbound adapters are unavailable", async () => {
    const { controller, sendMessageTelegram } = await createControllerHarnessWithoutTelegramOutbound();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_status",
      buildTelegramCommandContext({
        commandBody: "/cas_status",
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
      }),
    );

    expect(reply).toEqual({});
    expect(sendMessageTelegram).toHaveBeenCalledTimes(1);
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "123",
      expect.stringContaining("Binding: Discord Thread"),
      expect.objectContaining({
        accountId: "default",
        buttons: expect.any(Array),
      }),
    );
  });

  it("preserves Telegram buttons when the outbound adapter lacks sendPayload", async () => {
    const { controller, sendMessageTelegram } =
      await createControllerHarnessWithoutTelegramPayloadSupport();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_status",
      buildTelegramCommandContext({
        commandBody: "/cas_status",
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
      }),
    );

    expect(reply).toEqual({});
    expect(sendMessageTelegram).toHaveBeenCalledTimes(1);
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "123",
      expect.stringContaining("Binding: Discord Thread"),
      expect.objectContaining({
        accountId: "default",
        buttons: expect.any(Array),
      }),
    );
  });

  it("shows pending default controls when the bound thread is not materialized yet", async () => {
    const { controller, sendMessageTelegram, clientMock } = await createControllerHarness();
    clientMock.readThreadState.mockRejectedValue(
      new Error(
        "thread thread-1 is not materialized yet; includeTurns is unavailable before first user message",
      ),
    );
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_status",
      buildTelegramCommandContext({
        commandBody: "/cas_status",
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
      }),
    );

    expect(reply).toEqual({});
    expect(sendMessageTelegram).toHaveBeenCalledTimes(1);
    const firstCall = sendMessageTelegram.mock.calls[0] as unknown as
      | [string, string, { buttons?: Array<Array<{ text: string; callback_data: string }>> }]
      | undefined;
    const text = firstCall?.[1] ?? "";
    const buttons = firstCall?.[2]?.buttons ?? [];

    expect(text).toContain("Model: unknown");
    expect(text).toContain("saved as defaults until then");
    expect(buttons).toHaveLength(5);
    expect(buttons[0][0].text).toBe("Select Model");
    expect(buttons[0][1].text).toBe("Reasoning: Default");
    expect(buttons[1][0].text).toBe("Fast: toggle");
    expect(buttons[1][1].text).toBe("Permissions: toggle");
  });

  it("hides the fast button on status controls when the current model does not support it", async () => {
    const { controller, sendMessageTelegram } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      preferences: {
        preferredModel: "openai/gpt-5.2-codex",
        preferredServiceTier: "fast",
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_status",
      buildTelegramCommandContext({
        commandBody: "/cas_status",
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
      }),
    );
    expect(reply).toEqual({});
    const firstCall = sendMessageTelegram.mock.calls[0] as unknown as
      | [string, string, { buttons?: Array<Array<{ text: string; callback_data: string }>> }]
      | undefined;
    const buttons = firstCall?.[2]?.buttons ?? [];

    expect(buttons[1]).toHaveLength(1);
    expect(buttons[1][0].text).toBe("Permissions: toggle");
    expect(buttons[4][0].text).toBe("Skills");
    expect(buttons[4][1].text).toBe("MCPs");
    const kinds = buttons.flatMap((row: Array<{ callback_data: string }>) => {
      return row.map((button) => {
        const token = button.callback_data.split(":").pop() ?? "";
        return (controller as any).store.getCallback(token)?.kind;
      });
    });
    expect(kinds).not.toContain("toggle-fast");
  });

  it("renders saved conversation preferences in cas_status even if thread reads lag behind", async () => {
    const { controller, sendMessageTelegram } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      permissionsMode: "full-access",
      preferences: {
        preferredModel: "openai/gpt-5.3-codex",
        preferredReasoningEffort: "high",
        preferredServiceTier: "fast",
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_status",
      buildTelegramCommandContext({
        commandBody: "/cas_status",
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
      }),
    );
    expect(reply).toEqual({});
    const firstCall = sendMessageTelegram.mock.calls[0] as unknown as [string, string] | undefined;
    const text = firstCall?.[1] ?? "";
    expect(text).toContain("Binding: Discord Thread (openclaw)");
    expect(text).toContain("Model: openai/gpt-5.3-codex · reasoning high");
    expect(text).toContain("Fast mode: off");
    expect(text).toContain("Permissions: Full Access");
  });

  it("sends the status card directly to Discord with interactive controls", async () => {
    const { controller, sendComponentMessage } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand("cas_status", buildDiscordCommandContext({
      commandBody: "/cas_status",
      getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
    }));

    expect(reply).toEqual({
      text: "Sent Codex status controls to this Discord conversation.",
    });
    expect(sendComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      expect.objectContaining({
        text: expect.stringContaining("Binding: Discord Thread (openclaw)"),
        blocks: expect.arrayContaining([
          expect.objectContaining({
            buttons: expect.arrayContaining([
              expect.objectContaining({ label: "Select Model" }),
            ]),
          }),
        ]),
      }),
      expect.objectContaining({ accountId: "default" }),
    );
  });

  it("applies model, fast, and yolo flags from cas_status", async () => {
    const { controller, clientMock, sendMessageTelegram } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_status",
      buildTelegramCommandContext({
        args: "--model gpt-5.4 --fast --yolo",
        commandBody: "/cas_status --model gpt-5.4 --fast --yolo",
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
      }),
    );

    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.permissionsMode).toBe("full-access");
    expect(binding?.preferences?.preferredModel).toBe("gpt-5.4");
    expect(binding?.preferences?.preferredServiceTier).toBe("fast");
    expect(clientMock.setThreadModel).toHaveBeenCalledWith({
      profile: "full-access",
      sessionKey: "session-1",
      threadId: "thread-1",
      model: "gpt-5.4",
    });
    expect(clientMock.setThreadServiceTier).toHaveBeenCalledWith({
      profile: "full-access",
      sessionKey: "session-1",
      threadId: "thread-1",
      serviceTier: "fast",
    });
    expect(reply).toEqual({});
    const firstCall = sendMessageTelegram.mock.calls[0] as unknown as [string, string] | undefined;
    const text = firstCall?.[1] ?? "";
    expect(text).toContain("Model: gpt-5.4");
    expect(text).toContain("Fast mode: on");
    expect(text).toContain("Permissions: Full Access");
  });

  it("applies em-dash model, fast, and yolo flags from cas_status", async () => {
    const { controller, clientMock, sendMessageTelegram } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_status",
      buildTelegramCommandContext({
        args: "—model gpt-5.4 —fast —yolo",
        commandBody: "/cas_status —model gpt-5.4 —fast —yolo",
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
      }),
    );

    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.permissionsMode).toBe("full-access");
    expect(binding?.preferences?.preferredModel).toBe("gpt-5.4");
    expect(binding?.preferences?.preferredServiceTier).toBe("fast");
    expect(clientMock.setThreadModel).toHaveBeenCalledWith({
      profile: "full-access",
      sessionKey: "session-1",
      threadId: "thread-1",
      model: "gpt-5.4",
    });
    expect(clientMock.setThreadServiceTier).toHaveBeenCalledWith({
      profile: "full-access",
      sessionKey: "session-1",
      threadId: "thread-1",
      serviceTier: "fast",
    });
    expect(reply).toEqual({});
    const firstCall = sendMessageTelegram.mock.calls[0] as unknown as [string, string] | undefined;
    const text = firstCall?.[1] ?? "";
    expect(text).toContain("Model: gpt-5.4");
    expect(text).toContain("Fast mode: on");
    expect(text).toContain("Permissions: Full Access");
  });


  it("parses unicode em dash --sync for cas_rename and renames the Telegram topic", async () => {
    const { controller, clientMock, renameTopic } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      threadTitle: "Old Name",
      updatedAt: Date.now(),
    });
    clientMock.setThreadName = vi.fn(async () => ({
      threadId: "thread-1",
      threadName: "New Topic Name",
    }));

    const reply = await controller.handleCommand(
      "cas_rename",
      buildTelegramCommandContext({
        args: "—sync New Topic Name",
        commandBody: "/cas_rename —sync New Topic Name",
        messageThreadId: 456,
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
      }),
    );

    expect(clientMock.setThreadName).toHaveBeenCalledWith({
      profile: "default",
      sessionKey: "session-1",
      threadId: "thread-1",
      name: "New Topic Name",
    });
    expect(renameTopic).toHaveBeenCalledWith(
      "123",
      456,
      "New Topic Name",
      expect.objectContaining({ accountId: "default" }),
    );
    expect(reply).toEqual({ text: 'Renamed the Codex thread to "New Topic Name".' });
  });

  it("parses unicode em dash --sync for cas_resume and renames the Telegram topic", async () => {
    const { controller, renameTopic, sendMessageTelegram } = await createControllerHarness();

    const reply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "—sync thread-1",
        commandBody: "/cas_resume —sync thread-1",
        messageThreadId: 456,
      }),
    );

    expect(renameTopic).toHaveBeenCalledWith(
      "123",
      456,
      "Discord Thread (openclaw)",
      expect.objectContaining({ accountId: "default" }),
    );
    expect(reply).toEqual({});
    const lastCall = sendMessageTelegram.mock.calls.at(-1) as unknown as
      | [string, string, { buttons?: Array<Array<{ text: string }>>; messageThreadId?: number }]
      | undefined;
    expect(lastCall?.[0]).toBe("123");
    expect(lastCall?.[1]).toContain("Binding: Discord Thread (openclaw)");
    expect(lastCall?.[2]?.messageThreadId).toBe(456);
    expect(lastCall?.[2]?.buttons?.flat().map((button) => button.text)).toEqual(
      expect.arrayContaining(["Refresh", "Detach"]),
    );
  });

  it("pins the Telegram status message and unpins it on detach", async () => {
    const { controller, sendMessageTelegram } = await createControllerHarness();
    const fetchMock = vi.mocked(fetch);

    await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "thread-1",
        commandBody: "/cas_resume thread-1",
        messageThreadId: 456,
      }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottelegram-token/pinChatMessage",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(
      expect.objectContaining({
        chat_id: "123",
        message_id: 1,
      }),
    );
    const lastCall = sendMessageTelegram.mock.calls.at(-1) as unknown as
      | [string, string, { buttons?: Array<Array<{ text: string }>> }]
      | undefined;
    expect(lastCall?.[1]).toContain("Binding: Discord Thread (openclaw)");
    expect(
      sendMessageTelegram.mock.calls.some((call) =>
        String((call as unknown as [string, string])[1]).includes("Codex thread bound."),
      ),
    ).toBe(false);
    expect(lastCall?.[2]?.buttons?.flat().map((button) => button.text)).toEqual(
      expect.arrayContaining(["Refresh", "Detach"]),
    );
    expect(
      (controller as any).store.getBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      }),
    ).toEqual(
      expect.objectContaining({
        pinnedBindingMessage: {
          provider: "telegram",
          messageId: "1",
          chatId: "123",
        },
      }),
    );

    await controller.handleCommand(
      "cas_detach",
      buildTelegramCommandContext({
        commandBody: "/cas_detach",
        messageThreadId: 456,
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "binding-1" })),
      }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottelegram-token/unpinChatMessage",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("pins the Discord status message and unpins it on detach", async () => {
    const { controller, sendComponentMessage } = await createControllerHarness();
    const fetchMock = vi.mocked(fetch);
    vi.spyOn(controller as any, "resolveDiscordBotToken").mockResolvedValue("discord-token");

    await controller.handleCommand(
      "cas_resume",
      buildDiscordCommandContext({
        args: "thread-1",
        commandBody: "/cas_resume thread-1",
      }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/channels/channel%3Achan-1/pins/discord-component-1",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          Authorization: "Bot discord-token",
        }),
      }),
    );
    expect(sendComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      expect.objectContaining({
        text: expect.stringContaining("Binding: Discord Thread (openclaw)"),
        blocks: expect.arrayContaining([
          expect.objectContaining({
            buttons: expect.arrayContaining([
              expect.objectContaining({ label: "Refresh" }),
              expect.objectContaining({ label: "Detach" }),
            ]),
          }),
        ]),
      }),
      expect.objectContaining({ accountId: "default" }),
    );
    expect(
      (controller as any).store.getBinding({
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      }),
    ).toEqual(
      expect.objectContaining({
        pinnedBindingMessage: {
          provider: "discord",
          messageId: "discord-component-1",
          channelId: "channel:chan-1",
        },
      }),
    );

    await controller.handleCommand(
      "cas_detach",
      buildDiscordCommandContext({
        commandBody: "/cas_detach",
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "binding-1" })),
      }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/channels/channel%3Achan-1/pins/discord-component-1",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          Authorization: "Bot discord-token",
        }),
      }),
    );
  });

  it("replays pending cas_resume --sync effects after approval hydrates on the next resume command", async () => {
    const { controller, clientMock, renameTopic, sendMessageTelegram } = await createControllerHarness();
    (controller as any).client.readThreadContext = vi.fn(async () => ({
      lastUserMessage: "What were we doing here?",
      lastAssistantMessage: "We were working on the app-server lifetime refactor.",
    }));
    const requestConversationBinding = vi
      .fn()
      .mockResolvedValueOnce({
        status: "pending" as const,
        reply: { text: "Plugin bind approval required" },
      });

    const pendingReply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "--sync thread-1",
        commandBody: "/cas_resume --sync thread-1",
        messageThreadId: 456,
        requestConversationBinding,
      }),
    );

    expect(pendingReply).toEqual({ text: "Plugin bind approval required" });
    expect((controller as any).store.getPendingBind({
      channel: "telegram",
      accountId: "default",
      conversationId: "123:topic:456",
      parentConversationId: "123",
    })).toEqual(
      expect.objectContaining({
        threadId: "thread-1",
        syncTopic: true,
        notifyBound: true,
      }),
    );

    const hydratedReply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "--sync",
        commandBody: "/cas_resume --sync",
        messageThreadId: 456,
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
      }),
    );

    await flushAsyncWork();

    expect(renameTopic).toHaveBeenCalledWith(
      "123",
      456,
      "Discord Thread (openclaw)",
      expect.objectContaining({ accountId: "default" }),
    );
    expect(hydratedReply).toEqual({});
    const hydratedLastCall = sendMessageTelegram.mock.calls.at(-1) as unknown as
      | [string, string, { buttons?: Array<Array<{ text: string }>>; messageThreadId?: number }]
      | undefined;
    expect(hydratedLastCall?.[0]).toBe("123");
    expect(hydratedLastCall?.[1]).toContain("Binding: Discord Thread (openclaw)");
    expect(hydratedLastCall?.[2]?.messageThreadId).toBe(456);
    expect(hydratedLastCall?.[2]?.buttons?.flat().map((button) => button.text)).toEqual(
      expect.arrayContaining(["Refresh", "Detach"]),
    );
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "123",
      "Last User Request in Thread:",
      expect.objectContaining({ accountId: "default" }),
    );
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "123",
      "Last Agent Reply in Thread:",
      expect.objectContaining({ accountId: "default" }),
    );
  });

  it("retries an incomplete cas_resume bind before falling back to the picker", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertPendingBind({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      threadTitle: "Discord Thread",
      syncTopic: true,
      notifyBound: true,
      updatedAt: Date.now(),
    });
    const requestConversationBinding = vi.fn(async () => ({
      status: "pending" as const,
      reply: { text: "Plugin bind approval required" },
    }));

    const reply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "--sync",
        commandBody: "/cas_resume --sync",
        messageThreadId: 456,
        getCurrentConversationBinding: vi.fn(async () => null),
        requestConversationBinding,
      }),
    );

    expect(reply).toEqual({ text: "Plugin bind approval required" });
    expect(requestConversationBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: "Bind this conversation to Codex thread Discord Thread.",
      }),
    );
  });

  it("rebinds an incomplete cas_resume bind when the retry is approved immediately", async () => {
    const { controller, renameTopic, sendMessageTelegram } = await createControllerHarness();
    (controller as any).client.readThreadContext = vi.fn(async () => ({
      lastUserMessage: "What were we doing here?",
      lastAssistantMessage: "We were working on the app-server lifetime refactor.",
    }));

    await (controller as any).store.upsertPendingBind({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      threadTitle: "Discord Thread",
      syncTopic: true,
      notifyBound: true,
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "--sync",
        commandBody: "/cas_resume --sync",
        messageThreadId: 456,
        getCurrentConversationBinding: vi.fn(async () => null),
        requestConversationBinding: vi.fn(async () => ({ status: "bound" as const })),
      }),
    );

    await flushAsyncWork();

    expect(reply).toEqual({});
    expect(renameTopic).toHaveBeenCalledWith(
      "123",
      456,
      "Discord Thread (openclaw)",
      expect.objectContaining({ accountId: "default" }),
    );
    const reboundLastCall = sendMessageTelegram.mock.calls.at(-1) as unknown as
      | [string, string, { buttons?: Array<Array<{ text: string }>>; messageThreadId?: number }]
      | undefined;
    expect(reboundLastCall?.[0]).toBe("123");
    expect(reboundLastCall?.[1]).toContain("Binding: Discord Thread (openclaw)");
    expect(reboundLastCall?.[2]?.messageThreadId).toBe(456);
    expect(reboundLastCall?.[2]?.buttons?.flat().map((button) => button.text)).toEqual(
      expect.arrayContaining(["Refresh", "Detach"]),
    );
    expect(
      (controller as any).store.getBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      }),
    ).toEqual(
      expect.objectContaining({
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
      }),
    );
    expect(
      (controller as any).store.getPendingBind({
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      }),
    ).toBeNull();
  });

  it("applies pending bind effects immediately when core reports the bind was approved", async () => {
    const { controller, renameTopic, sendMessageTelegram } = await createControllerHarness();
    (controller as any).client.readThreadContext = vi.fn(async () => ({
      lastUserMessage: "What were we doing here?",
      lastAssistantMessage: "We were working on the app-server lifetime refactor.",
    }));

    await (controller as any).store.upsertPendingBind({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      threadTitle: "Discord Thread",
      syncTopic: true,
      notifyBound: true,
      updatedAt: Date.now(),
    });

    await controller.handleConversationBindingResolved({
      status: "approved",
      binding: {
        bindingId: "binding-1",
        pluginId: "openclaw-codex-app-server",
        pluginRoot: "/plugins/codex",
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
        threadId: 456,
        boundAt: Date.now(),
      },
      decision: "allow-once",
      request: {
        summary: "Bind this conversation to Codex thread Discord Thread.",
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "123:topic:456",
          parentConversationId: "123",
          threadId: 456,
        },
      },
    } as any);

    expect(renameTopic).toHaveBeenCalledWith(
      "123",
      456,
      "Discord Thread (openclaw)",
      expect.objectContaining({ accountId: "default" }),
    );
    const approvedLastCall = sendMessageTelegram.mock.calls.at(-1) as unknown as
      | [string, string, { buttons?: Array<Array<{ text: string }>>; messageThreadId?: number }]
      | undefined;
    expect(approvedLastCall?.[0]).toBe("123");
    expect(approvedLastCall?.[1]).toContain("Binding: Discord Thread (openclaw)");
    expect(approvedLastCall?.[2]?.messageThreadId).toBe(456);
    expect(approvedLastCall?.[2]?.buttons?.flat().map((button) => button.text)).toEqual(
      expect.arrayContaining(["Refresh", "Detach"]),
    );
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "123",
      "Last User Request in Thread:",
      expect.objectContaining({ accountId: "default", messageThreadId: 456 }),
    );
    expect(
      (controller as any).store.getPendingBind({
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      }),
    ).toBeNull();
  });

  it("still sends the bound status output when the approval restore hits a missing rollout error", async () => {
    const { controller, sendMessageTelegram } = await createControllerHarness();
    (controller as any).client.readThreadState = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("codex app server rpc error (-32600): no rollout found for thread id thread-1"),
      )
      .mockResolvedValue({
        threadId: "thread-1",
        threadName: "Discord Thread",
        model: "openai/gpt-5.4",
        cwd: "/repo/openclaw",
        serviceTier: "default",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      });

    await (controller as any).store.upsertPendingBind({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      threadTitle: "Discord Thread",
      syncTopic: false,
      notifyBound: true,
      updatedAt: Date.now(),
    });

    await expect(
      controller.handleConversationBindingResolved({
        status: "approved",
        binding: {
          bindingId: "binding-1",
          pluginId: "openclaw-codex-app-server",
          pluginRoot: "/plugins/codex",
          channel: "telegram",
          accountId: "default",
          conversationId: "123:topic:456",
          parentConversationId: "123",
          threadId: 456,
          boundAt: Date.now(),
        },
        decision: "allow-once",
        request: {
          summary: "Bind this conversation to Codex thread Discord Thread.",
          conversation: {
            channel: "telegram",
            accountId: "default",
            conversationId: "123:topic:456",
            parentConversationId: "123",
            threadId: 456,
          },
        },
      } as any),
    ).resolves.toBeUndefined();

    const approvedLastCall = sendMessageTelegram.mock.calls.at(-1) as
      | [string, string, { buttons?: Array<Array<{ text: string }>>; messageThreadId?: number }]
      | undefined;
    expect(approvedLastCall?.[0]).toBe("123");
    expect(approvedLastCall?.[1]).toContain("Binding: Discord Thread (openclaw)");
    expect(approvedLastCall?.[2]?.messageThreadId).toBe(456);
    expect(
      (controller as any).store.getPendingBind({
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      }),
    ).toBeNull();
  });

  it("still sends the bound status output when a new thread is not materialized yet", async () => {
    const { controller, sendMessageTelegram } = await createControllerHarness();
    (controller as any).client.readThreadState = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("codex app server rpc error (-32600): no rollout found for thread id thread-new"),
      )
      .mockRejectedValueOnce(
        new Error(
          "codex app server rpc error (-32600): thread thread-new is not materialized yet; includeTurns is unavailable before first user message",
        ),
      )
      .mockResolvedValue({
        threadId: "thread-new",
        threadName: "Fresh Thread",
        cwd: "/repo/openclaw",
        model: "openai/gpt-5.4",
        serviceTier: "default",
      });
    (controller as any).client.readThreadContext = vi.fn().mockRejectedValue(
      new Error(
        "codex app server rpc error (-32600): thread thread-new is not materialized yet; includeTurns is unavailable before first user message",
      ),
    );

    await (controller as any).store.upsertPendingBind({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      threadId: "thread-new",
      workspaceDir: "/repo/openclaw",
      threadTitle: "Fresh Thread",
      syncTopic: false,
      notifyBound: true,
      updatedAt: Date.now(),
    });

    await expect(
      controller.handleConversationBindingResolved({
        status: "approved",
        binding: {
          bindingId: "binding-1",
          pluginId: "openclaw-codex-app-server",
          pluginRoot: "/plugins/codex",
          channel: "telegram",
          accountId: "default",
          conversationId: "123:topic:456",
          parentConversationId: "123",
          threadId: 456,
          boundAt: Date.now(),
        },
        decision: "allow-once",
        request: {
          summary: "Bind this conversation to Codex thread Fresh Thread.",
          conversation: {
            channel: "telegram",
            accountId: "default",
            conversationId: "123:topic:456",
            parentConversationId: "123",
            threadId: 456,
          },
        },
      } as any),
    ).resolves.toBeUndefined();

    const approvedLastCall = sendMessageTelegram.mock.calls.at(-1) as
      | [string, string, { buttons?: Array<Array<{ text: string }>>; messageThreadId?: number }]
      | undefined;
    expect(approvedLastCall?.[0]).toBe("123");
    expect(approvedLastCall?.[1]).toContain("Binding: Fresh Thread (openclaw)");
    expect(approvedLastCall?.[1]).toContain("Thread: thread-new");
    expect(approvedLastCall?.[2]?.messageThreadId).toBe(456);
    expect(
      (controller as any).store.getPendingBind({
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      }),
    ).toBeNull();
  });

  it("still sends the bound status output when a new thread replay read reports thread not loaded", async () => {
    const { controller, sendMessageTelegram } = await createControllerHarness();
    (controller as any).client.readThreadState = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("codex app server rpc error (-32600): no rollout found for thread id thread-new"),
      )
      .mockRejectedValueOnce(
        new Error("codex app server rpc error (-32600): thread not loaded: thread-new"),
      )
      .mockResolvedValue({
        threadId: "thread-new",
        threadName: "Fresh Thread",
        cwd: "/repo/openclaw",
        model: "openai/gpt-5.4",
        serviceTier: "default",
      });
    (controller as any).client.readThreadContext = vi.fn().mockRejectedValue(
      new Error("codex app server rpc error (-32600): thread not loaded: thread-new"),
    );

    await (controller as any).store.upsertPendingBind({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      threadId: "thread-new",
      workspaceDir: "/repo/openclaw",
      threadTitle: "Fresh Thread",
      syncTopic: false,
      notifyBound: true,
      updatedAt: Date.now(),
    });

    await expect(
      controller.handleConversationBindingResolved({
        status: "approved",
        binding: {
          bindingId: "binding-1",
          pluginId: "openclaw-codex-app-server",
          pluginRoot: "/plugins/codex",
          channel: "telegram",
          accountId: "default",
          conversationId: "123:topic:456",
          parentConversationId: "123",
          threadId: 456,
          boundAt: Date.now(),
        },
        decision: "allow-once",
        request: {
          summary: "Bind this conversation to Codex thread Fresh Thread.",
          conversation: {
            channel: "telegram",
            accountId: "default",
            conversationId: "123:topic:456",
            parentConversationId: "123",
            threadId: 456,
          },
        },
      } as any),
    ).resolves.toBeUndefined();

    const approvedLastCall = sendMessageTelegram.mock.calls.at(-1) as
      | [string, string, { buttons?: Array<Array<{ text: string }>>; messageThreadId?: number }]
      | undefined;
    expect(approvedLastCall?.[0]).toBe("123");
    expect(approvedLastCall?.[1]).toContain("Binding: Fresh Thread (openclaw)");
    expect(approvedLastCall?.[1]).toContain("Thread: thread-new");
    expect(approvedLastCall?.[2]?.messageThreadId).toBe(456);
    expect(
      (controller as any).store.getPendingBind({
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      }),
    ).toBeNull();
  });

  it("preserves pending model and yolo overrides when approval completes after resume-thread selection", async () => {
    const { controller } = await createControllerHarness();

    await (controller as any).store.upsertPendingBind({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      threadTitle: "Discord Thread",
      permissionsMode: "full-access",
      preferences: {
        preferredModel: "gpt-5.3-codex-spark",
        updatedAt: Date.now(),
      },
      syncTopic: false,
      notifyBound: false,
      updatedAt: Date.now(),
    });

    await controller.handleConversationBindingResolved({
      status: "approved",
      binding: {
        bindingId: "binding-1",
        pluginId: "openclaw-codex-app-server",
        pluginRoot: "/plugins/codex",
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
        threadId: 456,
        boundAt: Date.now(),
      },
      decision: "allow-once",
      request: {
        summary: "Bind this conversation to Codex thread Discord Thread.",
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "123:topic:456",
          parentConversationId: "123",
          threadId: 456,
        },
      },
    } as any);

    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123:topic:456",
      parentConversationId: "123",
    });
    expect(binding?.permissionsMode).toBe("full-access");
    expect(binding?.preferences?.preferredModel).toBe("gpt-5.3-codex-spark");
  });

  it("clears pending bind state immediately when core reports the bind was denied", async () => {
    const { controller, renameTopic, sendMessageTelegram } = await createControllerHarness();

    await (controller as any).store.upsertPendingBind({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      threadTitle: "Discord Thread",
      syncTopic: true,
      notifyBound: true,
      updatedAt: Date.now(),
    });

    await controller.handleConversationBindingResolved({
      status: "denied",
      decision: "deny",
      request: {
        summary: "Bind this conversation to Codex thread Discord Thread.",
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "123:topic:456",
          parentConversationId: "123",
          threadId: 456,
        },
      },
    } as any);

    expect(renameTopic).not.toHaveBeenCalled();
    expect(sendMessageTelegram).not.toHaveBeenCalled();
    expect(
      (controller as any).store.getPendingBind({
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      }),
    ).toBeNull();
  });

  it("preserves syncTopic on Telegram resume pickers and renames the topic after callback bind", async () => {
    const { controller, renameTopic } = await createControllerHarness();
    const callback = await (controller as any).store.putCallback({
      kind: "resume-thread",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      syncTopic: true,
    });

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123:topic:456",
      parentConversationId: "123",
      threadId: 456,
      requestConversationBinding: vi.fn(async () => ({ status: "bound" as const })),
      callback: {
        payload: callback.token,
      },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
      },
    } as any);

    expect(renameTopic).toHaveBeenCalledWith(
      "123",
      456,
      "Discord Thread (openclaw)",
      expect.objectContaining({ accountId: "default" }),
    );
  });

  it("keeps preview-derived thread titles through resume callback binding when core has no live name", async () => {
    const { controller, clientMock, renameTopic, sendMessageTelegram } = await createControllerHarness();
    clientMock.readThreadState.mockResolvedValue({
      threadId: "019d2cbc-9fee-7862-8d02-683dfef71851",
      model: "gpt-5.4",
      modelProvider: "openai",
      reasoningEffort: "high",
      cwd: "/repo/openclaw-app-server",
      serviceTier: "default",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    const callback = await (controller as any).store.putCallback({
      kind: "resume-thread",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      threadId: "019d2cbc-9fee-7862-8d02-683dfef71851",
      threadTitle: "What is wrong with this layout?",
      workspaceDir: "/repo/openclaw-app-server",
      syncTopic: true,
    });

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123:topic:456",
      parentConversationId: "123",
      threadId: 456,
      requestConversationBinding: vi.fn(async () => ({ status: "bound" as const })),
      callback: {
        payload: callback.token,
      },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
      },
    } as any);

    expect(renameTopic).toHaveBeenCalledWith(
      "123",
      456,
      "What is wrong with this layout? (openclaw-app-server)",
      expect.objectContaining({ accountId: "default" }),
    );
    expect(
      sendMessageTelegram.mock.calls.some((call) =>
        String((call as unknown as [string, string])[1]).includes(
          "Binding: What is wrong with this layout? (openclaw-app-server)",
        ),
      ),
    ).toBe(true);
    expect(
      (controller as any).store.getBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      }),
    ).toEqual(
      expect.objectContaining({
        threadId: "019d2cbc-9fee-7862-8d02-683dfef71851",
        threadTitle: "What is wrong with this layout?",
      }),
    );
  });

  it("dispatches start-new-thread callbacks through thread creation and binding", async () => {
    const { controller, clientMock } = await createControllerHarness();
    const callback = await (controller as any).store.putCallback({
      kind: "start-new-thread",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      workspaceDir: "/repo/openclaw",
    });
    const requestConversationBinding = vi.fn(async () => ({ status: "bound" as const }));

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123:topic:456",
      parentConversationId: "123",
      threadId: 456,
      requestConversationBinding,
      callback: {
        payload: callback.token,
      },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
      },
    } as any);

    expect(clientMock.startThread).toHaveBeenCalledWith({
      profile: "default",
      sessionKey: undefined,
      workspaceDir: "/repo/openclaw",
      model: undefined,
    });
    expect(requestConversationBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.stringContaining("Bind this conversation to Codex thread"),
      }),
    );
  });

  it("preserves em-dash model and yolo overrides when New is chosen from the resume picker", async () => {
    const { controller, clientMock } = await createControllerHarness();

    const reply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "—model gpt-5.3-codex-spark —yolo",
        commandBody: "/cas_resume —model gpt-5.3-codex-spark —yolo",
      }),
    );

    const buttons = (reply.channelData as any)?.telegram?.buttons;
    const newCallbackData = buttons?.flat().find((button: { text: string }) => button.text === "New")?.callback_data as
      | string
      | undefined;
    expect(newCallbackData).toMatch(/^codexapp:/);

    const editMessage = vi.fn(async (_payload: any) => {});
    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: newCallbackData?.slice("codexapp:".length) },
      requestConversationBinding: vi.fn(async () => ({ status: "bound" as const })),
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    const projectButtons = editMessage.mock.calls.at(-1)?.[0]?.buttons as
      | Array<Array<{ text: string; callback_data: string }>>
      | undefined;
    const projectCallbackData = projectButtons?.[0]?.[0]?.callback_data;
    expect(projectCallbackData).toMatch(/^codexapp:/);

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: projectCallbackData?.slice("codexapp:".length) },
      requestConversationBinding: vi.fn(async () => ({ status: "bound" as const })),
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
      },
    } as any);

    expect(clientMock.startThread).toHaveBeenCalledWith({
      profile: "full-access",
      sessionKey: undefined,
      workspaceDir: "/repo/openclaw",
      model: "gpt-5.3-codex-spark",
    });
    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.permissionsMode).toBe("full-access");
    expect(binding?.preferences?.preferredModel).toBe("gpt-5.3-codex-spark");
  });

  it("routes /cas_new through the new-thread full-access path", async () => {
    const { controller, clientMock } = await createControllerHarness();
    const requestConversationBinding = vi.fn(async () => ({ status: "bound" as const }));

    const reply = await controller.handleCommand(
      "cas_new",
      buildTelegramCommandContext({
        commandBody: "/cas_new",
        requestConversationBinding,
      }),
    );

    expect(reply).toEqual({});
    expect(clientMock.startThread).toHaveBeenCalledWith({
      profile: "full-access",
      sessionKey: undefined,
      workspaceDir: "/repo/openclaw",
      model: undefined,
    });
    expect(requestConversationBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.stringContaining("Bind this conversation to Codex thread"),
      }),
    );
  });

  it("clears inherited task state when /cas_new starts a fresh thread", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-old",
      workspaceDir: "/repo/openclaw",
      taskState: {
        stage: "verifying",
        goal: "Git push",
        nextAction: "Review the latest Codex result",
      },
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_new",
      buildTelegramCommandContext({
        commandBody: "/cas_new",
        requestConversationBinding: vi.fn(async () => ({ status: "bound" as const })),
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "binding-1" })),
      }),
    );

    expect(reply).toEqual({});
    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.threadId).toBe("thread-new");
    expect(binding?.taskState).toBeUndefined();
  });

  it("preserves task state when a /cas_resume new-thread callback starts a fresh thread", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-old",
      workspaceDir: "/repo/openclaw",
      taskState: {
        stage: "verifying",
        goal: "Git push",
        nextAction: "Review the latest Codex result",
      },
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "start-new-thread",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      workspaceDir: "/repo/openclaw",
      preserveTaskState: true,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      requestConversationBinding: vi.fn(async () => ({ status: "bound" as const })),
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
      },
    } as any);

    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.threadId).toBe("thread-new");
    expect(binding?.taskState).toEqual(
      expect.objectContaining({
        stage: "verifying",
        goal: "Git push",
        nextAction: "Review the latest Codex result",
      }),
    );
  });

  it("sends the Telegram bind approval prompt only once for resume callbacks", async () => {
    const { controller } = await createControllerHarness();
    const callback = await (controller as any).store.putCallback({
      kind: "resume-thread",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
    });
    const reply = vi.fn(async () => {});
    const buttons = [[{ text: "Allow once", callback_data: "pluginbind:approval:o" }]];

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123:topic:456",
      parentConversationId: "123",
      threadId: 456,
      requestConversationBinding: vi.fn(async () => ({
        status: "pending" as const,
        reply: {
          text: "Plugin bind approval required",
          channelData: {
            telegram: {
              buttons,
            },
          },
        },
      })),
      callback: {
        payload: callback.token,
      },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply,
        editMessage: vi.fn(async () => {}),
      },
    } as any);

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({
      text: "Plugin bind approval required",
      buttons,
    });
  });

  it("renders Telegram bind approval buttons from interactive reply blocks", async () => {
    const { controller } = await createControllerHarness();
    const callback = await (controller as any).store.putCallback({
      kind: "resume-thread",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
    });
    const reply = vi.fn(async () => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123:topic:456",
      parentConversationId: "123",
      threadId: 456,
      requestConversationBinding: vi.fn(async () => ({
        status: "pending" as const,
        reply: {
          text: "Plugin bind approval required",
          interactive: {
            blocks: [
              {
                type: "buttons",
                buttons: [
                  {
                    label: "Allow once",
                    value: "pluginbind:approval:o",
                    style: "success",
                  },
                  {
                    label: "Always allow",
                    value: "pluginbind:approval:a",
                    style: "primary",
                  },
                  {
                    label: "Deny",
                    value: "pluginbind:approval:d",
                    style: "danger",
                  },
                ],
              },
            ],
          },
        } as any,
      })),
      callback: {
        payload: callback.token,
      },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply,
        editMessage: vi.fn(async () => {}),
      },
    } as any);

    expect(reply).toHaveBeenCalledWith({
      text: "Plugin bind approval required",
      buttons: [
        [
          { text: "Allow once", callback_data: "pluginbind:approval:o", style: "success" },
          { text: "Always allow", callback_data: "pluginbind:approval:a", style: "primary" },
          { text: "Deny", callback_data: "pluginbind:approval:d", style: "danger" },
        ],
      ],
    });
  });

  it("offers compact rename style buttons for cas_rename --sync without a name", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      threadTitle: "Discord Thread",
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_rename",
      buildTelegramCommandContext({
        args: "--sync",
        commandBody: "/cas_rename --sync",
        messageThreadId: 456,
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
      }),
    );

    expect(reply.text).toContain("Choose a name style");
    const buttons = (reply.channelData as any)?.telegram?.buttons;
    expect(buttons).toHaveLength(2);
    expect(buttons[0][0].text).toBe("Discord Thread (openclaw)");
    expect(buttons[1][0].text).toBe("Discord Thread");
    expect(String(buttons[0][0].callback_data)).toMatch(/^codexapp:/);
    expect(String(buttons[0][0].callback_data).length).toBeLessThan(64);
  });

  it("deduplicates repeated project suffixes in rename style suggestions", async () => {
    const { controller } = await createControllerHarness();
    (controller as any).client.readThreadState = vi.fn(async () => ({
      threadId: "thread-1",
      threadName: "Explore OAuth login for gifgrep (gifgrep) (gifgrep)",
      cwd: "/repo/gifgrep",
    }));
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/gifgrep",
      threadTitle: "Explore OAuth login for gifgrep (gifgrep) (gifgrep)",
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_rename",
      buildTelegramCommandContext({
        args: "--sync",
        commandBody: "/cas_rename --sync",
        messageThreadId: 456,
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
      }),
    );

    const buttons = (reply.channelData as any)?.telegram?.buttons;
    expect(buttons).toHaveLength(2);
    expect(buttons[0][0].text).toBe("Explore OAuth login for gifgrep (gifgrep)");
    expect(buttons[1][0].text).toBe("Explore OAuth login for gifgrep");
  });

  it("requests approved conversation binding when binding a Discord thread", async () => {
    const { controller } = await createControllerHarness();
    const requestConversationBinding = vi.fn(async () => ({ status: "bound" as const }));

    await controller.handleCommand("cas_resume", buildDiscordCommandContext({
      args: "thread-1",
      commandBody: "/cas_resume thread-1",
      requestConversationBinding,
    }));

    expect(requestConversationBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.stringContaining("Bind this conversation to Codex thread"),
      }),
    );
  });

  it("sends the Discord bind approval prompt only once for resume callbacks", async () => {
    const { controller, sendComponentMessage } = await createControllerHarness();
    const callback = await (controller as any).store.putCallback({
      kind: "resume-thread",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
    });
    const acknowledge = vi.fn(async () => {});
    const clearComponents = vi.fn(async () => {});
    const reply = vi.fn(async () => {});
    const requestConversationBinding = vi.fn(async () => ({
      status: "pending" as const,
      reply: {
        text: "Plugin bind approval required",
        channelData: {
          telegram: {
            buttons: [[{ text: "Allow once", callback_data: "pluginbind:approval:o" }]],
          },
        },
      },
    }));

    await controller.handleDiscordInteractive({
      channel: "discord",
      accountId: "default",
      interactionId: "interaction-1",
      conversationId: "channel:chan-1",
      auth: { isAuthorizedSender: true },
      interaction: {
        kind: "button",
        data: `codexapp:${callback.token}`,
        namespace: "codexapp",
        payload: callback.token,
        messageId: "message-1",
      },
      senderId: "user-1",
      senderUsername: "Ada",
      requestConversationBinding,
      respond: {
        acknowledge,
        reply,
        followUp: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
        clearComponents,
      },
    } as any);

    expect(sendComponentMessage).toHaveBeenCalledTimes(1);
    expect(sendComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      expect.objectContaining({
        text: "Plugin bind approval required",
      }),
      expect.objectContaining({ accountId: "default" }),
    );
    expect(discordSdkState.editDiscordComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      "message-1",
      {
        text: "Binding approval requested below.",
      },
      expect.objectContaining({ accountId: "default" }),
    );
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(acknowledge.mock.invocationCallOrder[0]).toBeLessThan(
      requestConversationBinding.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(clearComponents).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it("claims inbound Discord messages for raw thread ids after a typed bind", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "hello",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
    }));
    (controller as any).client.startTurn = startTurn;

    const result = await controller.handleInboundClaim({
      content: "who are you?",
      channel: "discord",
      accountId: "default",
      conversationId: "1481858418548412579",
      isGroup: true,
      metadata: { guildId: "guild-1" },
    });

    expect(result).toEqual({ handled: true });
    expect(startTurn).toHaveBeenCalled();
  });

  it("matches a Discord binding even when the inbound event includes a parent conversation id", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "hello",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
    }));
    (controller as any).client.startTurn = startTurn;

    const result = await controller.handleInboundClaim({
      content: "What is the CWD?",
      channel: "discord",
      accountId: "default",
      conversationId: "1481858418548412579",
      parentConversationId: "987654321",
      isGroup: true,
      metadata: { guildId: "guild-1" },
    });

    expect(result).toEqual({ handled: true });
    expect(startTurn).toHaveBeenCalled();
  });

  it("does not claim inbound Discord messages when only core binding state exists", async () => {
    const { controller } = await createControllerHarness();

    const result = await controller.handleInboundClaim({
      content: "who are you?",
      channel: "discord",
      accountId: "default",
      conversationId: "1481858418548412579",
      isGroup: true,
      metadata: { guildId: "guild-1" },
    });

    expect(result).toEqual({ handled: false });
  });

  it("uses a raw Discord channel id for the typing lease on inbound claims", async () => {
    const { controller, discordTypingStart } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    (controller as any).client.startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "hello",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
    }));

    const result = await controller.handleInboundClaim({
      content: "hello",
      channel: "discord",
      accountId: "default",
      conversationId: "1481858418548412579",
      isGroup: true,
      metadata: { guildId: "guild-1" },
    });

    expect(result).toEqual({ handled: true });
    expect(discordTypingStart).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "1481858418548412579",
        accountId: "default",
      }),
    );
  });

  it("skips the Discord typing lease for bound DM inbound claims", async () => {
    const { controller, discordTypingStart } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "user:1177378744822943744",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    (controller as any).client.startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "hello",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
    }));

    const result = await controller.handleInboundClaim({
      content: "hello",
      channel: "discord",
      accountId: "default",
      conversationId: "user:1177378744822943744",
      isGroup: false,
      metadata: {},
    });

    expect(result).toEqual({ handled: true });
    expect(discordTypingStart).not.toHaveBeenCalled();
  });

  it("forwards inbound Discord image metadata as a localImage turn input item", async () => {
    const { controller, stateDir } = await createControllerHarness();
    const imagePath = path.join(stateDir, "tmp", "inbound.png");
    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    fs.writeFileSync(imagePath, "png");
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "looks like a screenshot",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;

    const result = await controller.handleInboundClaim({
      content: "What is in this image?",
      channel: "discord",
      accountId: "default",
      conversationId: "1481858418548412579",
      isGroup: true,
      metadata: { guildId: "guild-1", mediaPath: imagePath, mediaType: "image/png" },
    });

    expect(result).toEqual({ handled: true });
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "What is in this image?",
        input: [
          { type: "text", text: "What is in this image?" },
          { type: "localImage", path: imagePath },
        ],
      }),
    );
  });

  it("supports image-only inbound claims when media metadata is present", async () => {
    const { controller, stateDir } = await createControllerHarness();
    const imagePath = path.join(stateDir, "tmp", "image-only.jpg");
    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    fs.writeFileSync(imagePath, "jpg");
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "described",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;

    const result = await controller.handleInboundClaim({
      content: "",
      channel: "telegram",
      accountId: "default",
      conversationId: TEST_TELEGRAM_PEER_ID,
      isGroup: false,
      metadata: { mediaPath: imagePath, mediaType: "image/jpeg" },
    });

    expect(result).toEqual({ handled: true });
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "",
        input: [{ type: "localImage", path: imagePath }],
      }),
    );
  });

  it("supports Telegram photo captions when inbound metadata uses MsgContext-style media fields", async () => {
    const { controller, stateDir } = await createControllerHarness();
    const imagePath = path.join(stateDir, "tmp", "caption-photo.jpg");
    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    fs.writeFileSync(imagePath, "jpg");
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "described",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;

    const result = await controller.handleInboundClaim({
      content: "What is on this screenshot?",
      channel: "telegram",
      accountId: "default",
      conversationId: TEST_TELEGRAM_PEER_ID,
      isGroup: false,
      metadata: {
        MediaPaths: [imagePath],
        MediaTypes: ["image/jpeg"],
      },
    });

    expect(result).toEqual({ handled: true });
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "What is on this screenshot?",
        input: [
          { type: "text", text: "What is on this screenshot?" },
          { type: "localImage", path: imagePath },
        ],
      }),
    );
  });

  it("forwards text file inbound media metadata as text turn input", async () => {
    const { controller, stateDir } = await createControllerHarness();
    const filePath = path.join(stateDir, "tmp", "note.txt");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "hello");
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "handled",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;

    const result = await controller.handleInboundClaim({
      content: "Read this file",
      channel: "discord",
      accountId: "default",
      conversationId: "1481858418548412579",
      isGroup: true,
      metadata: { guildId: "guild-1", mediaPath: filePath, mediaType: "text/plain" },
    });

    expect(result).toEqual({ handled: true });
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Read this file",
        input: [
          { type: "text", text: "Read this file" },
          {
            type: "text",
            text: `Attached file: note.txt\nLocal path: ${filePath}\nContent-Type: text/plain\n\nhello`,
          },
        ],
      }),
    );
  });

  it("detects markdown attachments by file extension when mime metadata is absent", async () => {
    const { controller, stateDir } = await createControllerHarness();
    const filePath = path.join(stateDir, "tmp", "README.md");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "# Heading\n\nBody text.\n");
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "handled",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;

    const result = await controller.handleInboundClaim({
      content: "",
      channel: "telegram",
      accountId: "default",
      conversationId: TEST_TELEGRAM_PEER_ID,
      isGroup: false,
      metadata: { mediaPath: filePath },
    });

    expect(result).toEqual({ handled: true });
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "",
        input: [
          {
            type: "text",
            text: `Attached file: README.md\nLocal path: ${filePath}\n\n# Heading\n\nBody text.\n`,
          },
        ],
      }),
    );
  });

  it("passes unsupported binary documents through as local file references", async () => {
    const { controller, stateDir } = await createControllerHarness();
    const filePath = path.join(stateDir, "tmp", "manual.pdf");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "%PDF");
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "handled",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;

    const result = await controller.handleInboundClaim({
      content: "Read this document",
      channel: "discord",
      accountId: "default",
      conversationId: "1481858418548412579",
      isGroup: true,
      metadata: { guildId: "guild-1", mediaPath: filePath, mediaType: "application/pdf" },
    });

    expect(result).toEqual({ handled: true });
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Read this document",
        input: [
          { type: "text", text: "Read this document" },
          {
            type: "text",
            text:
              `Attached file: manual.pdf\nLocal path: ${filePath}\nContent-Type: application/pdf\n\nUse this local file path directly from the server workspace. Do not ask the user to re-upload it unless the path is unreadable.`,
          },
        ],
      }),
    );
  });

  it("implements a plan by switching back to default mode with a short prompt", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "run-prompt",
      token: "run-prompt-token",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      workspaceDir: "/repo/openclaw",
      prompt: "Implement the plan.",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "openai/gpt-5.4",
          developerInstructions: null,
        },
      },
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "implemented",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;
    const reply = vi.fn(async () => {});
    const followUp = vi.fn(async () => {});

    await controller.handleDiscordInteractive({
      channel: "discord",
      accountId: "default",
      interactionId: "interaction-1",
      conversationId: "channel:chan-1",
      auth: { isAuthorizedSender: true },
      interaction: {
        kind: "button",
        data: `codexapp:${callback.token}`,
        namespace: "codexapp",
        payload: callback.token,
        messageId: "message-1",
      },
      senderId: "user-1",
      senderUsername: "Ada",
      respond: {
        acknowledge: vi.fn(async () => {}),
        reply,
        followUp,
        editMessage: vi.fn(async () => {}),
        clearComponents: vi.fn(async () => {}),
      },
    } as any);

    expect(reply).not.toHaveBeenCalled();
    expect(followUp).toHaveBeenCalledWith({ text: "Sent the plan to Codex.", ephemeral: true });
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Implement the plan.",
        collaborationMode: {
          mode: "default",
          settings: {
            model: "openai/gpt-5.4",
            developerInstructions: null,
          },
        },
      }),
    );
  });

  it("supports cas_plan off to interrupt an active plan run", async () => {
    const { controller } = await createControllerHarness();
    const interrupt = vi.fn(async () => {});
    (controller as any).activeRuns.set("discord::default::channel:chan-1::", {
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      workspaceDir: "/repo/openclaw",
      mode: "plan",
      handle: {
        result: Promise.resolve({ threadId: "thread-1", text: "planned" }),
        queueMessage: vi.fn(async () => true),
        getThreadId: () => "thread-1",
        interrupt,
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      },
    });

    const reply = await controller.handleCommand(
      "cas_plan",
      buildDiscordCommandContext({
        args: "off",
        commandBody: "/cas_plan off",
      }),
    );

    expect(interrupt).toHaveBeenCalled();
    expect(reply).toEqual({
      text: "Exited Codex plan mode. Future turns will use default coding mode.",
    });
  });

  it("queues a normal inbound message into an active plan run as steer by default", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const staleQueueMessage = vi.fn(async () => true);
    const staleInterrupt = vi.fn(async () => {});
    (controller as any).activeRuns.set("discord::default::channel:1481858418548412579::", {
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      workspaceDir: "/repo/openclaw",
      mode: "plan",
      handle: {
        result: Promise.resolve({ threadId: "thread-1", text: "stale-plan" }),
        queueMessage: staleQueueMessage,
        getThreadId: () => "thread-1",
        interrupt: staleInterrupt,
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      },
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "hello",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;

    const result = await controller.handleInboundClaim({
      content: "And? Build it?",
      channel: "discord",
      accountId: "default",
      conversationId: "1481858418548412579",
      isGroup: true,
      metadata: { guildId: "guild-1" },
    });

    expect(result).toEqual({ handled: true });
    expect(staleQueueMessage).toHaveBeenCalledWith("And? Build it?", [
      { type: "text", text: "And? Build it?" },
    ]);
    expect(staleInterrupt).not.toHaveBeenCalled();
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("treats a plain-text stop message as cas_stop for an active run", async () => {
    const { controller, sendMessageTelegram } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const staleQueueMessage = vi.fn(async () => true);
    const staleInterrupt = vi.fn(async () => {});
    (controller as any).activeRuns.set(`telegram::default::${TEST_TELEGRAM_PEER_ID}::`, {
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      workspaceDir: "/repo/openclaw",
      mode: "default",
      handle: {
        result: Promise.resolve({ threadId: "thread-1", text: "stale" }),
        queueMessage: staleQueueMessage,
        getThreadId: () => "thread-1",
        interrupt: staleInterrupt,
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      },
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({ threadId: "thread-1", text: "fresh" }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;

    const result = await controller.handleInboundClaim({
      content: "stop",
      channel: "telegram",
      accountId: "default",
      conversationId: TEST_TELEGRAM_PEER_ID,
      isGroup: false,
      metadata: {},
    });

    expect(result).toEqual({ handled: true });
    expect(staleQueueMessage).not.toHaveBeenCalled();
    expect(staleInterrupt).toHaveBeenCalled();
    expect(startTurn).not.toHaveBeenCalled();
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      TEST_TELEGRAM_PEER_ID,
      "Stopping Codex now.",
      expect.objectContaining({ accountId: "default" }),
    );
  });

  it("forwards transcribed audio into the bound Codex topic as normal text", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-1003701370893:topic:9",
        parentConversationId: "-1003701370893",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "ok",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;

    await (controller as any).handleMessageTranscribed({
      context: {
        channelId: "telegram",
        accountId: "default",
        conversationId: "-1003701370893:topic:9",
        messageId: "voice-1",
        transcript: "сделай это как обычный текст",
      },
    });

    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "сделай это как обычный текст",
      }),
    );
  });

  it("does not double-forward preprocessed audio when the transcript hook already handled it", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-1003701370893:topic:9",
        parentConversationId: "-1003701370893",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "ok",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;

    await (controller as any).handleMessageTranscribed({
      context: {
        channelId: "telegram",
        accountId: "default",
        conversationId: "-1003701370893:topic:9",
        messageId: "voice-2",
        transcript: "проверь дубликаты",
      },
    });
    await (controller as any).handleMessagePreprocessed({
      context: {
        channelId: "telegram",
        accountId: "default",
        conversationId: "-1003701370893:topic:9",
        messageId: "voice-2",
        transcript: "проверь дубликаты",
      },
    });

    expect(startTurn).toHaveBeenCalledTimes(1);
  });

  it("recovers the bound Telegram topic from session bindings when hook context only has the parent chat", async () => {
    const { controller, api } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-1003701370893:topic:9",
        parentConversationId: "-1003701370893",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    ((api as any).runtime.channel.bindings.listBySession as any).mockReturnValue([
      {
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "-1003701370893:topic:9",
          parentConversationId: "-1003701370893",
        },
      },
    ]);
    const handleInboundClaim = vi.fn(async () => ({ handled: true }));
    (controller as any).handleInboundClaim = handleInboundClaim;

    await (controller as any).handleMessageTranscribed({
      sessionKey: "session-1",
      context: {
        channelId: "telegram",
        accountId: "default",
        conversationId: "-1003701370893",
        messageId: "voice-3",
        transcript: "это должно уйти в topic steer",
      },
    });

    expect(handleInboundClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "это должно уйти в topic steer",
        conversationId: "-1003701370893:topic:9",
        parentConversationId: "-1003701370893",
        threadId: 9,
      }),
    );
  });

  it("passes trusted local media roots when sending a Telegram plan attachment", async () => {
    const { controller, sendMessageTelegram, stateDir } = await createControllerHarness();
    const attachmentPath = path.join(stateDir, "tmp", "plan.md");
    fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
    fs.writeFileSync(attachmentPath, "# Plan\n");

    const sent = await (controller as any).sendReply(
      {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      {
        mediaUrl: attachmentPath,
      },
    );

    expect(sent).toBe(true);
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      TEST_TELEGRAM_PEER_ID,
      "",
      expect.objectContaining({
        mediaUrl: attachmentPath,
        mediaLocalRoots: expect.arrayContaining([stateDir, path.dirname(attachmentPath)]),
      }),
    );
  });

  it("falls back to direct Telegram Bot API text delivery when the runtime send path says chat not found", async () => {
    const { api, sendMessageTelegram } = createApiMock();
    const controller = new CodexPluginController(api);
    await controller.start();
    sendMessageTelegram.mockRejectedValue(
      new Error("Telegram send failed: chat not found (chat_id=-1003701370893)"),
    );
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          message_id: 9001,
          chat: {
            id: -1003701370893,
          },
        },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const sent = await (controller as any).sendReply(
      {
        channel: "telegram",
        accountId: "default",
        conversationId: "-1003701370893:topic:3",
        parentConversationId: "-1003701370893",
        threadId: 3,
      },
      {
        text: "Recovered via direct Bot API fallback.",
      },
    );

    expect(sent).toBe(true);
    expect(sendMessageTelegram).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottelegram-token/sendMessage",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          chat_id: "-1003701370893",
          text: "Recovered via direct Bot API fallback.",
          message_thread_id: 3,
        }),
      }),
    );
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("retrying via direct Bot API fallback"),
    );
  });

  it("passes trusted local media roots when sending a Discord plan attachment", async () => {
    const { controller, sendMessageDiscord, stateDir } = await createControllerHarness();
    const attachmentPath = path.join(stateDir, "tmp", "plan.md");
    fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
    fs.writeFileSync(attachmentPath, "# Plan\n");

    const sent = await (controller as any).sendReply(
      {
        channel: "discord",
        accountId: "default",
        conversationId: "user:1177378744822943744",
      },
      {
        mediaUrl: attachmentPath,
      },
    );

    expect(sent).toBe(true);
    expect(sendMessageDiscord).toHaveBeenCalledWith(
      "user:1177378744822943744",
      "",
      expect.objectContaining({
        mediaUrl: attachmentPath,
        mediaLocalRoots: expect.arrayContaining([stateDir, path.dirname(attachmentPath)]),
      }),
    );
  });

  it("restarts a Discord bound run when the active queue path fails", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const staleInterrupt = vi.fn(async () => {});
    (controller as any).activeRuns.set("discord::default::channel:1481858418548412579::", {
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      workspaceDir: "/repo/openclaw",
      mode: "default",
      handle: {
        result: Promise.resolve({ threadId: "thread-1", text: "stale" }),
        queueMessage: vi.fn(async () => {
          throw new Error("codex app server rpc error (-32600): Invalid request: missing field `threadId`");
        }),
        getThreadId: () => "thread-1",
        interrupt: staleInterrupt,
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      },
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "hello",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;

    const result = await controller.handleInboundClaim({
      content: "who are you?",
      channel: "discord",
      accountId: "default",
      conversationId: "1481858418548412579",
      isGroup: true,
      metadata: { guildId: "guild-1" },
    });

    expect(result).toEqual({ handled: true });
    expect(staleInterrupt).toHaveBeenCalled();
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        existingThreadId: "thread-1",
        prompt: "who are you?",
      }),
    );
  });

  it("warns and restarts when an active run declines a queued prompt", async () => {
    const { controller, api } = await createControllerHarness();
    const staleInterrupt = vi.fn(async () => {});
    (controller as any).activeRuns.set("discord::default::channel:chan-1::", {
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      workspaceDir: "/repo/openclaw",
      mode: "default",
      handle: {
        result: Promise.resolve({ threadId: "thread-1", text: "stale" }),
        queueMessage: vi.fn(async () => false),
        getThreadId: () => "thread-1",
        interrupt: staleInterrupt,
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      },
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "fresh",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;

    await (controller as any).startTurn({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      binding: {
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:chan-1",
        },
        sessionKey: "session-1",
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        updatedAt: Date.now(),
      },
      workspaceDir: "/repo/openclaw",
      prompt: "who are you?",
      reason: "command",
    });

    expect(staleInterrupt).toHaveBeenCalled();
    expect(startTurn).toHaveBeenCalled();
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("reached an active run but was not accepted; restarting"),
    );
  });

  it("retries a bound turn on a fresh thread when the stored thread is missing", async () => {
    const { controller, sendMessageTelegram, api, clientMock } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "openclaw-codex-app-server:thread:thread-stale",
      threadId: "thread-stale",
      workspaceDir: "/repo/openclaw",
      taskState: {
        goal: "Keep the long-lived cockpit flow alive",
        stage: "executing",
        nextAction: "Wait for Codex output",
        verification: {
          status: "unverified",
          updatedAt: Date.now(),
        },
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    });
    (clientMock.readThreadState as any).mockImplementation(async (params: { threadId: string }) => ({
      threadId: params.threadId,
      threadName: params.threadId === "thread-2" ? "Recovered Thread" : "Stale Thread",
      model: "openai/gpt-5.4",
      cwd: "/repo/openclaw",
      serviceTier: "default",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    }));
    const startTurn = vi
      .fn()
      .mockImplementationOnce(() => ({
        result: Promise.reject(
          new Error("codex app server rpc error (-32600): thread not found: thread-stale"),
        ),
        getThreadId: () => "thread-stale",
        queueMessage: vi.fn(async () => false),
        interrupt: vi.fn(async () => {}),
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      }))
      .mockImplementation(() => ({
        result: Promise.resolve({
          threadId: "thread-2",
          text: "Recovered on a fresh thread.",
        }),
        getThreadId: () => "thread-2",
        queueMessage: vi.fn(async () => false),
        interrupt: vi.fn(async () => {}),
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      }));
    (controller as any).client.startTurn = startTurn;

    await (controller as any).startTurn({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      binding: (controller as any).store.getBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      }),
      workspaceDir: "/repo/openclaw",
      prompt: "continue",
      reason: "command",
    });
    await flushAsyncWork();
    await flushAsyncWork();
    await vi.waitFor(() => {
      expect(startTurn).toHaveBeenCalledTimes(2);
    });

    expect(startTurn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        existingThreadId: "thread-stale",
        sessionKey: "openclaw-codex-app-server:thread:thread-stale",
      }),
    );
    expect(startTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        existingThreadId: undefined,
        sessionKey: "openclaw-codex-app-server:thread:thread-stale",
      }),
    );
    expect((controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    })).toEqual(
      expect.objectContaining({
        sessionKey: "openclaw-codex-app-server:thread:thread-stale",
        threadId: "thread-2",
        threadTitle: "Recovered Thread",
        taskState: expect.objectContaining({
          goal: "Keep the long-lived cockpit flow alive",
        }),
      }),
    );
    expect(sendMessageTelegram.mock.calls.some((call) => String(call[1]).includes("Codex failed:"))).toBe(
      false,
    );
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("retrying without the stale thread binding"),
    );
  });

  it("retries a fresh turn when the newly created thread loses its rollout", async () => {
    const { controller, sendMessageTelegram, api, clientMock } = await createControllerHarness();
    const conversation = {
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    } as const;
    const expectedSessionKey = buildConversationSessionKey(conversation);
    (clientMock.readThreadState as any).mockImplementation(async (params: { threadId: string }) => ({
      threadId: params.threadId,
      threadName: params.threadId === "thread-2" ? "Recovered Thread" : "Fresh Thread",
      model: "openai/gpt-5.4",
      cwd: "/repo/openclaw",
      serviceTier: "default",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    }));
    const startTurn = vi
      .fn()
      .mockImplementationOnce(() => ({
        result: Promise.reject(
          new Error("codex app server rpc error (-32600): no rollout found for thread id thread-new"),
        ),
        getThreadId: () => "thread-new",
        queueMessage: vi.fn(async () => false),
        interrupt: vi.fn(async () => {}),
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      }))
      .mockImplementation(() => ({
        result: Promise.resolve({
          threadId: "thread-2",
          text: "Recovered on a fresh thread.",
        }),
        getThreadId: () => "thread-2",
        queueMessage: vi.fn(async () => false),
        interrupt: vi.fn(async () => {}),
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      }));
    (controller as any).client.startTurn = startTurn;

    await (controller as any).startTurn({
      conversation,
      binding: null,
      workspaceDir: "/repo/openclaw",
      prompt: "Ship the long-lived cockpit flow",
      reason: "command",
    });
    await flushAsyncWork();
    await flushAsyncWork();
    await vi.waitFor(() => {
      expect(startTurn).toHaveBeenCalledTimes(2);
    });

    expect(startTurn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        existingThreadId: undefined,
        sessionKey: expectedSessionKey,
      }),
    );
    expect(startTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        existingThreadId: undefined,
        sessionKey: expectedSessionKey,
      }),
    );
    expect((controller as any).store.getBinding(conversation)).toEqual(
      expect.objectContaining({
        sessionKey: expectedSessionKey,
        threadId: "thread-2",
        threadTitle: "Recovered Thread",
      }),
    );
    expect(sendMessageTelegram.mock.calls.some((call) => String(call[1]).includes("Codex failed:"))).toBe(
      false,
    );
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("staleThread=thread-new"),
    );
  });

  it("uses the runtime conversation session key when a local binding is missing one", async () => {
    const { controller, api, clientMock } = await createControllerHarness();
    const conversation = {
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      parentConversationId: "group-1",
    } as const;
    const targetSessionKey = "plugin-binding:openclaw-codex-app-server:test-session";
    (api.runtime.channel.bindings.resolveByConversation as any).mockReturnValue({
      targetSessionKey,
    });
    (clientMock.readThreadState as any).mockResolvedValue({
      threadId: "thread-1",
      threadName: "Recovered Thread",
      model: "openai/gpt-5.4",
      cwd: "/repo/openclaw",
      serviceTier: "default",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "OK",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => false),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;

    await (controller as any).startTurn({
      conversation,
      binding: {
        conversation,
        threadId: "thread-stale",
        workspaceDir: "/repo/openclaw",
        permissionsMode: "full-access",
        updatedAt: Date.now(),
      } as any,
      workspaceDir: "/repo/openclaw",
      prompt: "continue",
      reason: "command",
    });
    await flushAsyncWork();
    await flushAsyncWork();

    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: targetSessionKey,
        existingThreadId: "thread-stale",
      }),
    );
    expect((controller as any).store.getBinding(conversation)).toEqual(
      expect.objectContaining({
        sessionKey: targetSessionKey,
        threadId: "thread-1",
      }),
    );
  });

  it("queues structured text input onto an active run via steer", async () => {
    const { controller } = await createControllerHarness();
    const staleInterrupt = vi.fn(async () => {});
    const staleQueueMessage = vi.fn(async () => true);
    (controller as any).activeRuns.set("discord::default::channel:chan-1::", {
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      workspaceDir: "/repo/openclaw",
      mode: "default",
      handle: {
        result: Promise.resolve({ threadId: "thread-1", text: "stale" }),
        queueMessage: staleQueueMessage,
        getThreadId: () => "thread-1",
        interrupt: staleInterrupt,
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      },
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "fresh",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;

    await (controller as any).startTurn({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      binding: {
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:chan-1",
        },
        sessionKey: "session-1",
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        updatedAt: Date.now(),
      },
      workspaceDir: "/repo/openclaw",
      prompt: "Read this file",
      input: [
        { type: "text", text: "Read this file" },
        { type: "text", text: "Attached file: note.txt\n\nhello" },
      ],
      reason: "inbound",
    });

    expect(staleQueueMessage).toHaveBeenCalledWith("Read this file", [
      { type: "text", text: "Read this file" },
      { type: "text", text: "Attached file: note.txt\n\nhello" },
    ]);
    expect(staleInterrupt).not.toHaveBeenCalled();
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("queues image metadata onto an active run via steer instead of stopping it", async () => {
    const { controller, stateDir } = await createControllerHarness();
    const imagePath = path.join(stateDir, "tmp", "active-image.png");
    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    fs.writeFileSync(imagePath, "png");
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const staleQueueMessage = vi.fn(async () => true);
    const staleInterrupt = vi.fn(async () => {});
    (controller as any).activeRuns.set(`telegram::default::${TEST_TELEGRAM_PEER_ID}::`, {
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      workspaceDir: "/repo/openclaw",
      mode: "default",
      handle: {
        result: Promise.resolve({ threadId: "thread-1", text: "stale" }),
        queueMessage: staleQueueMessage,
        getThreadId: () => "thread-1",
        interrupt: staleInterrupt,
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      },
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({ threadId: "thread-1", text: "fresh" }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;

    const result = await controller.handleInboundClaim({
      content: "давай 100 по умолчанию поставим",
      channel: "telegram",
      accountId: "default",
      conversationId: TEST_TELEGRAM_PEER_ID,
      isGroup: false,
      metadata: { mediaPath: imagePath, mediaType: "image/png" },
    });

    expect(result).toEqual({ handled: true });
    expect(staleQueueMessage).toHaveBeenCalledWith("давай 100 по умолчанию поставим", [
      { type: "text", text: "давай 100 по умолчанию поставим" },
      { type: "localImage", path: imagePath },
    ]);
    expect(staleInterrupt).not.toHaveBeenCalled();
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("adds compact reply context when a Telegram reply steers an active run", async () => {
    const { controller } = await createControllerHarness();
    const staleQueueMessage = vi.fn(async () => true);
    const staleInterrupt = vi.fn(async () => {});
    (controller as any).activeRuns.set(`telegram::default::${TEST_TELEGRAM_PEER_ID}::`, {
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      workspaceDir: "/repo/openclaw",
      mode: "default",
      handle: {
        result: Promise.resolve({ threadId: "thread-1", text: "stale" }),
        queueMessage: staleQueueMessage,
        getThreadId: () => "thread-1",
        interrupt: staleInterrupt,
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      },
    });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          success: true,
          data: [
            'ID: 9002 | Evgeny "Chip" | Date: 2026-04-14 16:58:03+00:00 | reply to 9001 | Message: а это вот переделай',
            'ID: 9001 | Claw | Date: 2026-04-14 16:57:40+00:00 | Message: Сначала почини только voice handoff',
          ].join("\n"),
        }),
    } as Response);

    const result = await controller.handleInboundClaim({
      content: "а это вот переделай",
      channel: "telegram",
      accountId: "default",
      conversationId: TEST_TELEGRAM_PEER_ID,
      messageId: "9002",
      isGroup: false,
      metadata: {},
    });

    expect(result).toEqual({ handled: true });
    expect(staleQueueMessage).toHaveBeenCalledWith("а это вот переделай", [
      {
        type: "text",
        text: expect.stringContaining("[Reply context]"),
      },
      { type: "text", text: "а это вот переделай" },
    ]);
    expect(staleQueueMessage).toHaveBeenCalledWith(
      "а это вот переделай",
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("Original sender: Claw"),
        }),
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("Original message id: 9001"),
        }),
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("Сначала почини только voice handoff"),
        }),
      ]),
    );
    expect(staleInterrupt).not.toHaveBeenCalled();
  });

  it("adds compact reply context when a Telegram reply starts a new turn", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({ threadId: "thread-1", text: "ok" }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          success: true,
          data: [
            'ID: 9012 | Evgeny "Chip" | Date: 2026-04-14 16:59:03+00:00 | reply to 9011 | Message: нет, давай через topic binding',
            'ID: 9011 | Claw | Date: 2026-04-14 16:58:40+00:00 | Message: Я бы делал это через session fallback',
          ].join("\n"),
        }),
    } as Response);

    const result = await controller.handleInboundClaim({
      content: "нет, давай через topic binding",
      channel: "telegram",
      accountId: "default",
      conversationId: TEST_TELEGRAM_PEER_ID,
      messageId: "9012",
      isGroup: false,
      metadata: {},
    });

    expect(result).toEqual({ handled: true });
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "нет, давай через topic binding",
        input: [
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("Original message id: 9011"),
          }),
          { type: "text", text: "нет, давай через topic binding" },
        ],
      }),
    );
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("Я бы делал это через session fallback"),
          }),
        ]),
      }),
    );
  });

  it("does not send the plan keepalive after a questionnaire is already visible", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T13:10:00-04:00"));
    try {
      const harness = await createControllerHarness();
      const { controller } = harness;
      const { sendMessageTelegram } = harness;
      let resolveResult: ((value: unknown) => void) | undefined;
      const result = new Promise((resolve) => {
        resolveResult = resolve;
      });
      (controller as any).client.startTurn = vi.fn((params: any) => {
        void Promise.resolve().then(() =>
          params.onPendingInput?.({
            requestId: "req-plan-1",
            options: [],
            expiresAt: Date.now() + 7 * 24 * 60 * 60_000,
            method: "item/tool/requestUserInput",
            questionnaire: {
              currentIndex: 0,
              questions: [
                {
                  index: 0,
                  id: "breakfast",
                  header: "Breakfast",
                  prompt: "Do you like cereal or bagels?",
                  options: [
                    { key: "A", label: "Cereal (Recommended)", description: "Choose cereal." },
                    { key: "B", label: "Bagels", description: "Choose bagels." },
                  ],
                  guidance: [],
                  allowFreeform: true,
                },
              ],
              answers: [null],
              responseMode: "structured",
            },
          }),
        );
        return {
          result,
          getThreadId: () => "thread-1",
          queueMessage: vi.fn(async () => false),
          interrupt: vi.fn(async () => {}),
          isAwaitingInput: () => true,
          submitPendingInput: vi.fn(async () => false),
          submitPendingInputPayload: vi.fn(async () => false),
        };
      });

      await (controller as any).startPlan({
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: TEST_TELEGRAM_PEER_ID,
        },
        binding: null,
        workspaceDir: "/repo/openclaw",
        prompt: "Ask the breakfast question.",
      });

      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(12_500);
      await vi.runOnlyPendingTimersAsync();
      await Promise.resolve();
      await Promise.resolve();

      const sentTexts = sendMessageTelegram.mock.calls.flatMap((call) => {
        const [, text] = call as unknown as [unknown, unknown];
        return typeof text === "string" ? [text] : [];
      });
      expect(sentTexts).toContain(
        "Starting Codex plan mode. I’ll relay the questions and final plan as they arrive.",
      );
      expect((controller as any).store.getPendingRequestById("req-plan-1")).not.toBeNull();
      expect(sentTexts).not.toContain("Codex is still planning...");

      resolveResult?.({
        threadId: "thread-1",
        aborted: true,
      });
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not send the turn keepalive after the run is already awaiting input", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-12T03:40:00+03:00"));
    try {
      const harness = await createControllerHarness();
      const { controller } = harness;
      const { sendMessageTelegram } = harness;
      let awaitingInput = false;
      let resolveResult: ((value: unknown) => void) | undefined;
      const result = new Promise((resolve) => {
        resolveResult = resolve;
      });
      (controller as any).client.startTurn = vi.fn((_params: any) => {
        void Promise.resolve().then(() => {
          awaitingInput = true;
        });
        return {
          result,
          getThreadId: () => "thread-awaiting-input",
          queueMessage: vi.fn(async () => false),
          interrupt: vi.fn(async () => {}),
          isAwaitingInput: () => awaitingInput,
          submitPendingInput: vi.fn(async () => false),
          submitPendingInputPayload: vi.fn(async () => false),
        };
      });

      await (controller as any).startTurn({
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: TEST_TELEGRAM_PEER_ID,
        },
        binding: null,
        workspaceDir: "/repo/openclaw",
        prompt: "Ask a follow-up question.",
        reason: "command",
      });

      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(12_500);
      await Promise.resolve();
      await Promise.resolve();

      const sentTexts = sendMessageTelegram.mock.calls.flatMap((call) => {
        const [, text] = call as unknown as [unknown, unknown];
        return typeof text === "string" ? [text] : [];
      });
      expect(sentTexts).not.toContain("Codex is still working...");

      resolveResult?.({
        threadId: "thread-awaiting-input",
        aborted: true,
      });
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers a fresh executing task on startup and restarts the turn keepalive cadence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T04:20:00+03:00"));
    try {
      const harness = createApiMock();
      const store = new PluginStateStore(harness.stateDir);
      await store.load();
      await store.upsertBinding({
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: TEST_TELEGRAM_PEER_ID,
        },
        sessionKey: buildConversationSessionKey({
          channel: "telegram",
          accountId: "default",
          conversationId: TEST_TELEGRAM_PEER_ID,
        }),
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        taskState: {
          stage: "executing",
          goal: "Finish the cockpit recovery patch",
          nextAction: "Wait for Codex to finish the current turn",
          checkpoint: {
            summary: "Gateway restarted before the turn completed",
            nextAction: "Resume from the saved checkpoint",
            savedAt: Date.now() - 20_000,
          },
          lastHeartbeatAt: Date.now() - 45_000,
          updatedAt: Date.now() - 45_000,
        },
        updatedAt: Date.now() - 45_000,
      });

      let resolveResult: ((value: unknown) => void) | undefined;
      const result = new Promise((resolve) => {
        resolveResult = resolve;
      });
      const controller = new CodexPluginController(harness.api);
      const clientMock = {
        hasProfile: vi.fn((profile: string) => profile === "default" || profile === "full-access"),
        logStartupProbe: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        listModels: vi.fn(async () => [{ id: "openai/gpt-5.4", current: true }]),
        readThreadState: vi.fn(async () => ({
          threadId: "thread-1",
          threadName: "Recovered Thread",
          model: "openai/gpt-5.4",
          cwd: "/repo/openclaw",
          serviceTier: "default",
          approvalPolicy: "on-request",
          sandbox: "workspace-write",
        })),
        readThreadContext: vi.fn(async () => ({
          lastUserMessage: "resume this",
          lastAssistantMessage: undefined,
        })),
        readAccount: vi.fn(async () => ({
          email: "test@example.com",
          planType: "pro",
          type: "chatgpt",
        })),
        readRateLimits: vi.fn(async () => []),
        startTurn: vi.fn(() => ({
          result,
          getThreadId: () => "thread-1",
          queueMessage: vi.fn(async () => false),
          interrupt: vi.fn(async () => {}),
          isAwaitingInput: () => false,
          submitPendingInput: vi.fn(async () => false),
          submitPendingInputPayload: vi.fn(async () => false),
        })),
      };
      (controller as any).client = clientMock;
      (controller as any).readThreadHasChanges = vi.fn(async () => false);

      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            success: true,
            data: [
              'ID: 7345 | Claw | Date: 2026-04-12 12:16:03+00:00 | Message: Codex is still working...',
              'ID: 7344 | Evgeny "Chip" | Date: 2026-04-12 12:15:40+00:00 | Message: Unrelated chat noise',
              'ID: 7343 | Evgeny "Chip" | Date: 2026-04-12 12:14:16+00:00 | reply to 7342 | Message: Add the latest Telegram context before resuming',
              'ID: 7342 | Evgeny "Chip" | Date: 2026-04-12 12:13:00+00:00 | Message: Resume from the saved checkpoint and keep the real thread context',
            ].join("\n"),
          }),
      } as Response);

      await controller.start();
      await Promise.resolve();
      await Promise.resolve();
      expect((controller as any).activeRuns.size).toBe(1);
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      expect(clientMock.startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: buildConversationSessionKey({
            channel: "telegram",
            accountId: "default",
            conversationId: TEST_TELEGRAM_PEER_ID,
          }),
          existingThreadId: "thread-1",
          workspaceDir: "/repo/openclaw",
          prompt: expect.stringContaining("Resume the current Codex task"),
          input: [
            expect.objectContaining({
              type: "text",
              text: expect.stringContaining("Add the latest Telegram context before resuming"),
            }),
            expect.objectContaining({
              type: "text",
              text: expect.stringContaining("Resume the current Codex task"),
            }),
          ],
        }),
      );

      const sentTextsBeforeKeepalive = harness.sendMessageTelegram.mock.calls.flatMap((call) => {
        const [, text] = call as unknown as [unknown, unknown];
        return typeof text === "string" ? [text] : [];
      });
      expect(sentTextsBeforeKeepalive).toContain(
        "Gateway restarted while Codex was working. Resuming the task from the saved checkpoint.",
      );
      expect(sentTextsBeforeKeepalive).toContain("Codex is still working...");

      const sentTexts = harness.sendMessageTelegram.mock.calls.flatMap((call) => {
        const [, text] = call as unknown as [unknown, unknown];
        return typeof text === "string" ? [text] : [];
      });
      expect((harness.api as any).logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("codex recovery keepalive tick failed"),
      );
      expect(sentTexts).toContain("Codex is still working...");

      resolveResult?.({
        threadId: "thread-1",
        text: "Recovered completion.",
      });
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not send recovery keepalive when the recovered run is already awaiting input", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T04:20:00+03:00"));
    try {
      const harness = createApiMock();
      const store = new PluginStateStore(harness.stateDir);
      await store.load();
      await store.upsertBinding({
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: TEST_TELEGRAM_PEER_ID,
        },
        sessionKey: buildConversationSessionKey({
          channel: "telegram",
          accountId: "default",
          conversationId: TEST_TELEGRAM_PEER_ID,
        }),
        threadId: "thread-awaiting-input",
        workspaceDir: "/repo/openclaw",
        taskState: {
          stage: "executing",
          goal: "Finish the cockpit recovery patch",
          nextAction: "Wait for Codex to finish the current turn",
          checkpoint: {
            summary: "Gateway restarted before the turn completed",
            nextAction: "Resume from the saved checkpoint",
            savedAt: Date.now() - 20_000,
          },
          lastHeartbeatAt: Date.now() - 45_000,
          updatedAt: Date.now() - 45_000,
        },
        updatedAt: Date.now() - 45_000,
      });

      let resolveResult: ((value: unknown) => void) | undefined;
      const result = new Promise((resolve) => {
        resolveResult = resolve;
      });
      const controller = new CodexPluginController(harness.api);
      const clientMock = {
        hasProfile: vi.fn((profile: string) => profile === "default" || profile === "full-access"),
        logStartupProbe: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        listModels: vi.fn(async () => [{ id: "openai/gpt-5.4", current: true }]),
        readThreadState: vi.fn(async () => ({
          threadId: "thread-awaiting-input",
          threadName: "Recovered Thread",
          model: "openai/gpt-5.4",
          cwd: "/repo/openclaw",
          serviceTier: "default",
          approvalPolicy: "on-request",
          sandbox: "workspace-write",
        })),
        readThreadContext: vi.fn(async () => ({
          lastUserMessage: "resume this",
          lastAssistantMessage: undefined,
        })),
        readAccount: vi.fn(async () => ({
          email: "test@example.com",
          planType: "pro",
          type: "chatgpt",
        })),
        readRateLimits: vi.fn(async () => []),
        startTurn: vi.fn(() => ({
          result,
          getThreadId: () => "thread-awaiting-input",
          queueMessage: vi.fn(async () => false),
          interrupt: vi.fn(async () => {}),
          isAwaitingInput: () => true,
          submitPendingInput: vi.fn(async () => false),
          submitPendingInputPayload: vi.fn(async () => false),
        })),
      };
      (controller as any).client = clientMock;
      (controller as any).readThreadHasChanges = vi.fn(async () => false);

      await controller.start();
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(12_500);
      await Promise.resolve();
      await Promise.resolve();

      const sentTexts = harness.sendMessageTelegram.mock.calls.flatMap((call) => {
        const [, text] = call as unknown as [unknown, unknown];
        return typeof text === "string" ? [text] : [];
      });
      expect(sentTexts).toContain(
        "Gateway restarted while Codex was working. Resuming the task from the saved checkpoint.",
      );
      expect(sentTexts).not.toContain("Codex is still working...");

      resolveResult?.({
        threadId: "thread-awaiting-input",
        aborted: true,
      });
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs startup recovery only once when start() is called concurrently", async () => {
    const harness = createApiMock();
    const store = new PluginStateStore(harness.stateDir);
    await store.load();
    await store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      sessionKey: buildConversationSessionKey({
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      }),
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      taskState: {
        stage: "executing",
        goal: "Resume a single interrupted task",
        nextAction: "Wait for Codex to finish the current turn",
        lastHeartbeatAt: Date.now() - 1_000,
        updatedAt: Date.now() - 1_000,
      },
      updatedAt: Date.now() - 1_000,
    });

    let releaseProbe: (() => void) | undefined;
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const controller = new CodexPluginController(harness.api);
    const clientMock = {
      hasProfile: vi.fn((profile: string) => profile === "default" || profile === "full-access"),
      logStartupProbe: vi.fn(async () => {
        await probeGate;
      }),
      close: vi.fn(async () => undefined),
      listModels: vi.fn(async () => [{ id: "openai/gpt-5.4", current: true }]),
      readThreadState: vi.fn(async () => ({
        threadId: "thread-1",
        threadName: "Recovered Thread",
        model: "openai/gpt-5.4",
        cwd: "/repo/openclaw",
        serviceTier: "default",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      })),
      readThreadContext: vi.fn(async () => ({
        lastUserMessage: "resume this",
        lastAssistantMessage: undefined,
      })),
      readAccount: vi.fn(async () => ({
        email: "test@example.com",
        planType: "pro",
        type: "chatgpt",
      })),
      readRateLimits: vi.fn(async () => []),
      startTurn: vi.fn(() => ({
        result: new Promise(() => {}),
        getThreadId: () => "thread-1",
        queueMessage: vi.fn(async () => false),
        interrupt: vi.fn(async () => {}),
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      })),
    };
    (controller as any).client = clientMock;
    (controller as any).readThreadHasChanges = vi.fn(async () => false);

    const firstStart = controller.start();
    const secondStart = controller.start();
    await Promise.resolve();
    releaseProbe?.();
    await Promise.all([firstStart, secondStart]);

    expect(clientMock.logStartupProbe).toHaveBeenCalledTimes(1);
    expect(clientMock.startTurn).toHaveBeenCalledTimes(1);
    const sentTexts = harness.sendMessageTelegram.mock.calls.flatMap((call) => {
      const [, text] = call as unknown as [unknown, unknown];
      return typeof text === "string" ? [text] : [];
    });
    expect(
      sentTexts.filter(
        (text) => text === "Gateway restarted while Codex was working. Resuming the task from the saved checkpoint.",
      ),
    ).toHaveLength(1);
  });

  it("rebounds startup recovery onto a fresh thread when the bound thread context is exhausted", async () => {
    const harness = createApiMock();
    const store = new PluginStateStore(harness.stateDir);
    await store.load();
    await store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      sessionKey: buildConversationSessionKey({
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      }),
      threadId: "thread-exhausted",
      workspaceDir: "/repo/openclaw",
      contextUsage: {
        totalTokens: 127_049,
        contextWindow: 121_600,
        remainingTokens: 0,
        remainingPercent: 0,
      },
      taskState: {
        stage: "executing",
        goal: "Resume the interrupted cockpit task safely",
        nextAction: "Continue from the saved checkpoint on a fresh thread if needed",
        checkpoint: {
          summary: "Turn interrupted before completion",
          nextAction: "Restart or steer the task",
          savedAt: Date.now() - 20_000,
        },
        lastHeartbeatAt: Date.now() - 45_000,
        updatedAt: Date.now() - 45_000,
      },
      updatedAt: Date.now() - 45_000,
    });

    const controller = new CodexPluginController(harness.api);
    const clientMock = {
      hasProfile: vi.fn((profile: string) => profile === "default" || profile === "full-access"),
      logStartupProbe: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      startThread: vi.fn(async () => ({
        threadId: "fresh-thread",
        threadName: "Fresh Recovery Thread",
        model: "openai/gpt-5.4",
        cwd: "/repo/openclaw",
        serviceTier: "default",
      })),
      startTurn: vi.fn(() => ({
        result: new Promise(() => {}),
        getThreadId: () => "fresh-thread",
        queueMessage: vi.fn(async () => false),
        interrupt: vi.fn(async () => {}),
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      })),
      readThreadState: vi.fn(async () => ({
        threadId: "fresh-thread",
        threadName: "Fresh Recovery Thread",
        model: "openai/gpt-5.4",
        cwd: "/repo/openclaw",
        serviceTier: "default",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      })),
      readThreadContext: vi.fn(async () => ({
        lastUserMessage: undefined,
        lastAssistantMessage: undefined,
      })),
      readAccount: vi.fn(async () => ({
        email: "test@example.com",
        planType: "pro",
        type: "chatgpt",
      })),
      readRateLimits: vi.fn(async () => []),
      listModels: vi.fn(async () => [{ id: "openai/gpt-5.4", current: true }]),
    };
    (controller as any).client = clientMock;
    (controller as any).readThreadHasChanges = vi.fn(async () => false);
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          success: true,
          data: [
            'ID: 7343 | Evgeny "Chip" | Date: 2026-04-12 12:14:16+00:00 | reply to 7342 | Message: Add the latest Telegram context before resuming',
            'ID: 7342 | Evgeny "Chip" | Date: 2026-04-12 12:13:00+00:00 | Message: Resume from the saved checkpoint and keep the real thread context',
          ].join("\n"),
        }),
    } as Response);

    await controller.start();

    expect(clientMock.startThread).toHaveBeenCalledTimes(1);
    expect(clientMock.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        existingThreadId: "fresh-thread",
        workspaceDir: "/repo/openclaw",
        prompt: expect.stringContaining("The previous Codex thread hit its context limit before recovery."),
        input: [
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("Add the latest Telegram context before resuming"),
          }),
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("The previous Codex thread hit its context limit before recovery."),
          }),
        ],
      }),
    );
    const reloadedStore = new PluginStateStore(harness.stateDir);
    await reloadedStore.load();
    const rebound = reloadedStore.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: TEST_TELEGRAM_PEER_ID,
    });
    expect(rebound?.threadId).toBe("fresh-thread");
    expect(rebound?.contextUsage).toBeUndefined();
    expect(rebound?.taskState).toEqual(
      expect.objectContaining({
        stage: "executing",
      }),
    );
    const sentTexts = harness.sendMessageTelegram.mock.calls.flatMap((call) => {
      const [, text] = call as unknown as [unknown, unknown];
      return typeof text === "string" ? [text] : [];
    });
    expect(sentTexts).toContain(
      "Gateway restarted while Codex was working. The previous thread context was full, so continuing on a fresh thread from the saved checkpoint.",
    );
  });

  it("auto-compacts idle gpt-5.4 bindings when remaining context drops to 35%", async () => {
    const harness = createApiMock();
    const store = new PluginStateStore(harness.stateDir);
    await store.load();
    await store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-1003701370893:topic:3",
        parentConversationId: "-1003701370893",
      },
      sessionKey: "openclaw-codex-app-server:thread:thread-low-context",
      threadId: "thread-low-context",
      workspaceDir: "/repo/openclaw",
      contextUsage: {
        totalTokens: 170_000,
        contextWindow: 258_400,
        remainingPercent: 34,
      },
      updatedAt: Date.now() - 10 * 60_000,
    });

    const controller = new CodexPluginController(harness.api);
    const clientMock = {
      hasProfile: vi.fn((profile: string) => profile === "default" || profile === "full-access"),
      logStartupProbe: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      readThreadState: vi.fn(async () => ({
        threadId: "thread-low-context",
        threadName: "Low Context Thread",
        model: "openai/gpt-5.4",
        cwd: "/repo/openclaw",
        serviceTier: "default",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      })),
      compactThread: vi.fn(async () => ({
        usage: {
          totalTokens: 96_000,
          contextWindow: 258_400,
          remainingPercent: 63,
        },
      })),
      readThreadContext: vi.fn(async () => ({
        lastUserMessage: undefined,
        lastAssistantMessage: undefined,
      })),
      readAccount: vi.fn(async () => ({
        email: "test@example.com",
        planType: "pro",
        type: "chatgpt",
      })),
      readRateLimits: vi.fn(async () => []),
    };
    (controller as any).client = clientMock;
    (controller as any).readThreadHasChanges = vi.fn(async () => false);

    await controller.start();

    expect(clientMock.compactThread).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-low-context",
      }),
    );
    const reloadedStore = new PluginStateStore(harness.stateDir);
    await reloadedStore.load();
    const rebound = reloadedStore.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "-1003701370893:topic:3",
      parentConversationId: "-1003701370893",
    });
    expect(rebound?.contextUsage).toEqual(
      expect.objectContaining({
        totalTokens: 96_000,
        remainingPercent: 63,
      }),
    );
    expect(rebound?.autoCompactState).toEqual(
      expect.objectContaining({
        lastThreadId: "thread-low-context",
        lastRemainingPercent: 63,
        lastTotalTokens: 96_000,
      }),
    );
    const sentTexts = harness.sendMessageTelegram.mock.calls.flatMap((call) => {
      const [, text] = call as unknown as [unknown, unknown];
      return typeof text === "string" ? [text] : [];
    });
    expect(
      sentTexts.some((text) =>
        text.includes("Context usage dropped to 34% remaining on openai/gpt-5.4.") &&
        text.includes("Current context usage: 170k / 258k tokens used (66% full)")
      ),
    ).toBe(true);
    expect(
      sentTexts.some((text) =>
        text.includes("Codex compaction completed.") &&
        text.includes("Starting context usage: 170k / 258k tokens used (66% full)") &&
        text.includes("Final context usage: 96k / 258k tokens used (37% full)") &&
        text.includes("Context remaining: 63%.")
      ),
    ).toBe(true);
  });

  it("respects the auto-compaction cooldown for low-context gpt-5.4 bindings", async () => {
    const harness = createApiMock();
    const store = new PluginStateStore(harness.stateDir);
    const now = Date.now();
    await store.load();
    await store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-1003701370893:topic:3",
        parentConversationId: "-1003701370893",
      },
      sessionKey: "openclaw-codex-app-server:thread:thread-low-context",
      threadId: "thread-low-context",
      workspaceDir: "/repo/openclaw",
      contextUsage: {
        totalTokens: 180_000,
        contextWindow: 258_400,
        remainingPercent: 30,
      },
      autoCompactState: {
        lastTriggeredAt: now - 30 * 60_000,
        lastCompletedAt: now - 29 * 60_000,
        lastThreadId: "thread-low-context",
        lastRemainingPercent: 62,
        lastTotalTokens: 98_000,
      },
      updatedAt: now - 30 * 60_000,
    });

    const controller = new CodexPluginController(harness.api);
    const clientMock = {
      hasProfile: vi.fn((profile: string) => profile === "default" || profile === "full-access"),
      logStartupProbe: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      readThreadState: vi.fn(async () => ({
        threadId: "thread-low-context",
        threadName: "Low Context Thread",
        model: "openai/gpt-5.4",
        cwd: "/repo/openclaw",
        serviceTier: "default",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      })),
      compactThread: vi.fn(async () => ({
        usage: {
          totalTokens: 95_000,
          contextWindow: 258_400,
          remainingPercent: 63,
        },
      })),
      readThreadContext: vi.fn(async () => ({
        lastUserMessage: undefined,
        lastAssistantMessage: undefined,
      })),
      readAccount: vi.fn(async () => ({
        email: "test@example.com",
        planType: "pro",
        type: "chatgpt",
      })),
      readRateLimits: vi.fn(async () => []),
    };
    (controller as any).client = clientMock;
    (controller as any).readThreadHasChanges = vi.fn(async () => false);

    await controller.start();

    expect(clientMock.compactThread).not.toHaveBeenCalled();
  });

  it("clears failed auto-compaction attempts so the next reconcile can retry", async () => {
    const harness = createApiMock();
    const store = new PluginStateStore(harness.stateDir);
    await store.load();
    await store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-1003701370893:topic:313",
        parentConversationId: "-1003701370893",
      },
      sessionKey: "openclaw-codex-app-server:thread:thread-stuck-low-context",
      threadId: "thread-stuck-low-context",
      workspaceDir: "/repo/openclaw",
      contextUsage: {
        totalTokens: 221_946,
        contextWindow: 258_400,
        remainingPercent: 14,
      },
      updatedAt: Date.now() - 10 * 60_000,
    });

    const controller = new CodexPluginController(harness.api);
    const clientMock = {
      hasProfile: vi.fn((profile: string) => profile === "default" || profile === "full-access"),
      logStartupProbe: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      readThreadState: vi.fn(async () => ({
        threadId: "thread-stuck-low-context",
        threadName: "Stuck Low Context Thread",
        model: "openai/gpt-5.4",
        cwd: "/repo/openclaw",
        serviceTier: "default",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      })),
      compactThread: vi.fn(async () => {
        throw new Error("transport warming up");
      }),
      readThreadContext: vi.fn(async () => ({
        lastUserMessage: undefined,
        lastAssistantMessage: undefined,
      })),
      readAccount: vi.fn(async () => ({
        email: "test@example.com",
        planType: "pro",
        type: "chatgpt",
      })),
      readRateLimits: vi.fn(async () => []),
    };
    (controller as any).client = clientMock;
    (controller as any).readThreadHasChanges = vi.fn(async () => false);

    await controller.start();

    const reloadedStore = new PluginStateStore(harness.stateDir);
    await reloadedStore.load();
    const rebound = reloadedStore.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "-1003701370893:topic:313",
      parentConversationId: "-1003701370893",
    });
    expect(rebound?.autoCompactState).toEqual(
      expect.objectContaining({
        lastThreadId: "thread-stuck-low-context",
        lastRemainingPercent: 14,
        lastTotalTokens: 221_946,
      }),
    );
    expect(rebound?.autoCompactState?.lastFailedAt).toEqual(expect.any(Number));
    expect(rebound?.autoCompactState?.lastCompletedAt).toBeUndefined();
  });

  it("rebinds auto-compaction targets onto a fresh thread when the rollout is missing", async () => {
    const harness = createApiMock();
    const store = new PluginStateStore(harness.stateDir);
    await store.load();
    await store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-1003701370893:topic:313",
        parentConversationId: "-1003701370893",
      },
      sessionKey: "openclaw-codex-app-server:thread:thread-stuck-low-context",
      threadId: "thread-stuck-low-context",
      workspaceDir: "/repo/openclaw",
      contextUsage: {
        totalTokens: 221_946,
        contextWindow: 258_400,
        remainingPercent: 14,
      },
      updatedAt: Date.now() - 10 * 60_000,
    });

    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-binding-summary-"));
    vi.stubEnv("HOME", fakeHome);
    const telegramStateDir = path.join(fakeHome, ".openclaw", "telegram");
    fs.mkdirSync(telegramStateDir, { recursive: true });
    const bindingPath = path.join(telegramStateDir, "thread-bindings-default.json");
    fs.writeFileSync(bindingPath, JSON.stringify({
      version: 1,
      bindings: [
        {
          accountId: "default",
          conversationId: "-1003701370893:topic:313",
          targetKind: "acp",
          targetSessionKey: "plugin-binding:test",
          metadata: {
            pluginBindingOwner: "plugin",
            pluginId: "test-plugin",
            summary: "Bind this conversation to Codex thread stale-thread.",
          },
        },
      ],
    }, null, 2));

    const controller = new CodexPluginController(harness.api);
    const clientMock = {
      hasProfile: vi.fn((profile: string) => profile === "default" || profile === "full-access"),
      logStartupProbe: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      startThread: vi.fn(async () => ({
        threadId: "fresh-thread",
        threadName: "Fresh Thread",
        model: "openai/gpt-5.4",
        cwd: "/repo/openclaw",
        serviceTier: "default",
      })),
      readThreadState: vi.fn(async () => ({
        threadId: "thread-stuck-low-context",
        threadName: "Stuck Low Context Thread",
        model: "openai/gpt-5.4",
        cwd: "/repo/openclaw",
        serviceTier: "default",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      })),
      compactThread: vi.fn(async () => {
        throw new Error("codex app server rpc error (-32600): no rollout found for thread id thread-stuck-low-context");
      }),
      readThreadContext: vi.fn(async () => ({
        lastUserMessage: undefined,
        lastAssistantMessage: undefined,
      })),
      readAccount: vi.fn(async () => ({
        email: "test@example.com",
        planType: "pro",
        type: "chatgpt",
      })),
      readRateLimits: vi.fn(async () => []),
    };
    (controller as any).client = clientMock;
    (controller as any).readThreadHasChanges = vi.fn(async () => false);

    await controller.start();

    expect(clientMock.compactThread).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-stuck-low-context",
      }),
    );
    expect(clientMock.startThread).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "openclaw-codex-app-server:thread:thread-stuck-low-context",
        workspaceDir: "/repo/openclaw",
      }),
    );

    const reloadedStore = new PluginStateStore(harness.stateDir);
    await reloadedStore.load();
    const rebound = reloadedStore.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "-1003701370893:topic:313",
      parentConversationId: "-1003701370893",
    });
    expect(rebound?.threadId).toBe("fresh-thread");
    expect(rebound?.contextUsage).toBeUndefined();
    expect(rebound?.autoCompactState).toBeUndefined();

    const bindingState = JSON.parse(fs.readFileSync(bindingPath, "utf8"));
    expect(bindingState.bindings[0]?.metadata?.summary).toContain("Fresh Thread");

    const sentTexts = harness.sendMessageTelegram.mock.calls.flatMap((call) => {
      const [, text] = call as unknown as [unknown, unknown];
      return typeof text === "string" ? [text] : [];
    });
    expect(sentTexts.some((text) => text.includes("fresh Codex thread"))).toBe(true);
    expect(sentTexts.some((text) => text.includes("Codex failed:"))).toBe(false);
  });

  it("auto-recovers stale verifying bindings onto a fresh thread", async () => {
    const harness = createApiMock();
    const store = new PluginStateStore(harness.stateDir);
    await store.load();
    await store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-1003701370893:topic:6685",
        parentConversationId: "-1003701370893",
      },
      sessionKey: "openclaw-codex-app-server:thread:old-thread",
      threadId: "old-thread",
      workspaceDir: "/repo/openclaw",
      contextUsage: {
        remainingPercent: 34,
      },
      taskState: {
        stage: "verifying",
        goal: "?",
        nextAction: "Review the latest Codex result",
        latestEvidence: "This stale summary still talks about topic:4 instead of the current topic.",
        verification: {
          status: "unverified",
          updatedAt: Date.now() - 10 * 60_000,
        },
        lastHeartbeatAt: Date.now() - 10 * 60_000,
        updatedAt: Date.now() - 10 * 60_000,
      },
      updatedAt: Date.now() - 10 * 60_000,
    });

    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-home-"));
    vi.stubEnv("HOME", fakeHome);
    const now = new Date();
    const sessionDir = path.join(
      fakeHome,
      ".openclaw",
      "codex-home",
      "sessions",
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "rollout-stale.jsonl"),
      `${JSON.stringify({
        timestamp: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
        type: "session_meta",
        payload: {
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: "old-thread",
              },
            },
          },
        },
      })}\n`,
      "utf8",
    );

    const controller = new CodexPluginController(harness.api);
    const clientMock = {
      hasProfile: vi.fn((profile: string) => profile === "default" || profile === "full-access"),
      logStartupProbe: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      startThread: vi.fn(async () => ({
        threadId: "fresh-thread",
        threadName: "Fresh Thread",
        model: "openai/gpt-5.4",
        cwd: "/repo/openclaw",
        serviceTier: "default",
      })),
      startTurn: vi.fn(() => ({
        result: new Promise(() => {}),
        getThreadId: () => "fresh-thread",
        queueMessage: vi.fn(async () => false),
        interrupt: vi.fn(async () => {}),
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      })),
      readThreadState: vi.fn(async () => ({
        threadId: "fresh-thread",
        threadName: "Fresh Thread",
        model: "openai/gpt-5.4",
        cwd: "/repo/openclaw",
        serviceTier: "default",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      })),
      readThreadContext: vi.fn(async () => ({
        lastUserMessage: undefined,
        lastAssistantMessage: undefined,
      })),
      readAccount: vi.fn(async () => ({
        email: "test@example.com",
        planType: "pro",
        type: "chatgpt",
      })),
      readRateLimits: vi.fn(async () => []),
      listModels: vi.fn(async () => [{ id: "openai/gpt-5.4", current: true }]),
    };
    (controller as any).client = clientMock;
    (controller as any).readThreadHasChanges = vi.fn(async () => false);
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          success: true,
          data: [
            'ID: 6691 | Evgeny "Chip" | Date: 2026-04-12 12:20:00+00:00 | reply to 6685 | Message: Use the fresh thread but keep the last Telegram context',
            'ID: 6685 | Evgeny "Chip" | Date: 2026-04-12 12:10:00+00:00 | Message: Original stale status topic root',
          ].join("\n"),
        }),
    } as Response);

    await controller.start();

    expect(clientMock.startThread).toHaveBeenCalledTimes(1);
    expect(clientMock.startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        existingThreadId: "fresh-thread",
        workspaceDir: "/repo/openclaw",
        prompt: expect.stringContaining("The previous Codex status thread became stale."),
        input: [
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("Use the fresh thread but keep the last Telegram context"),
          }),
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("The previous Codex status thread became stale."),
          }),
        ],
      }),
    );
    const reloadedStore = new PluginStateStore(harness.stateDir);
    await reloadedStore.load();
    const rebound = reloadedStore.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "-1003701370893:topic:6685",
      parentConversationId: "-1003701370893",
    });
    expect(rebound?.threadId).toBe("fresh-thread");
    expect(rebound?.taskState).toEqual(
      expect.objectContaining({
        stage: "executing",
        goal: "?",
      }),
    );
    const sentTexts = harness.sendMessageTelegram.mock.calls.flatMap((call) => {
      const [, text] = call as unknown as [unknown, unknown];
      return typeof text === "string" ? [text] : [];
    });
    expect(sentTexts).toContain(
      "Detected a stale Codex status thread. Rebinding this topic to a fresh thread and continuing from the saved task card.",
    );
  });

  it("does not resend the same questionnaire state when plan mode repeats the same pending input", async () => {
    const harness = await createControllerHarness();
    const { controller, sendMessageTelegram } = harness;
    let resolveResult: ((value: unknown) => void) | undefined;
    const result = new Promise((resolve) => {
      resolveResult = resolve;
    });
    const repeatedState = {
      requestId: "req-plan-repeat-1",
      options: [],
      expiresAt: Date.now() + 60_000,
      method: "item/tool/requestUserInput",
      questionnaire: {
        currentIndex: 0,
        questions: [
          {
            index: 0,
            id: "spec-source",
            header: "Spec Source",
            prompt: "Where is the spec?",
            options: [
              { key: "A", label: "Current clone", description: "Use the current clone." },
            ],
            guidance: [],
            allowFreeform: true,
          },
        ],
        answers: [null],
        responseMode: "structured",
      },
    };
    (controller as any).client.startTurn = vi.fn((params: any) => {
      void Promise.resolve()
        .then(() => params.onPendingInput?.(structuredClone(repeatedState)))
        .then(() => params.onPendingInput?.(structuredClone(repeatedState)));
      return {
        result,
        getThreadId: () => "thread-1",
        queueMessage: vi.fn(async () => false),
        interrupt: vi.fn(async () => {}),
        isAwaitingInput: () => true,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      };
    });

    await (controller as any).startPlan({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      binding: null,
      workspaceDir: "/repo/openclaw",
      prompt: "Ask once.",
    });

    await vi.waitFor(() => {
      const questionnaireMessages = sendMessageTelegram.mock.calls.filter((call) => {
        const [, text] = call as unknown as [unknown, unknown];
        return typeof text === "string" && text.includes("Where is the spec?");
      });
      expect(questionnaireMessages).toHaveLength(1);
    });

    resolveResult?.({
      threadId: "thread-1",
      aborted: true,
    });
  });

  it("tells the user to log back in when Codex reports OpenAI auth is required", async () => {
    const { controller, clientMock, sendMessageTelegram } = await createControllerHarness();
    clientMock.readAccount.mockResolvedValue({
      type: "chatgpt",
      requiresOpenaiAuth: true,
    } as any);
    (controller as any).client.startTurn = vi.fn(() => ({
      result: Promise.reject(new Error("codex app server rpc error (-32001): unauthorized")),
      getThreadId: () => undefined,
      queueMessage: vi.fn(async () => false),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));

    await (controller as any).startTurn({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      binding: {
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: TEST_TELEGRAM_PEER_ID,
        },
        sessionKey: "session-1",
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        updatedAt: Date.now(),
      },
      workspaceDir: "/repo/openclaw",
      prompt: "who are you?",
      reason: "inbound",
    });

    await flushAsyncWork();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      TEST_TELEGRAM_PEER_ID,
      "Codex authentication failed on this machine. Run `codex logout` and `codex login`, then try again.",
      expect.anything(),
    );
    expect(clientMock.readAccount).toHaveBeenCalledWith({
      profile: "default",
      sessionKey: "session-1",
      refreshToken: true,
    });
  });

  it("maps obvious OAuth failures to the same re-login guidance even if account/read also fails", async () => {
    const { controller, clientMock, sendMessageTelegram } = await createControllerHarness();
    clientMock.readAccount.mockRejectedValue(new Error("account probe failed"));
    (controller as any).client.startTurn = vi.fn(() => ({
      result: Promise.reject(new Error("refresh token expired")),
      getThreadId: () => undefined,
      queueMessage: vi.fn(async () => false),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));

    await (controller as any).startTurn({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      binding: null,
      workspaceDir: "/repo/openclaw",
      prompt: "who are you?",
      reason: "inbound",
    });

    await flushAsyncWork();
    await vi.waitFor(() => {
      expect(sendMessageTelegram).toHaveBeenCalledWith(
        TEST_TELEGRAM_PEER_ID,
        "Codex authentication failed on this machine. Run `codex logout` and `codex login`, then try again.",
        expect.anything(),
      );
    });
  });

  it("surfaces explicit failed turns as auth failures when the terminal error is unauthorized", async () => {
    const { controller, clientMock, sendMessageTelegram } = await createControllerHarness();
    (controller as any).client.startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        terminalStatus: "failed",
        terminalError: {
          message: "unauthorized",
          codexErrorInfo: "unauthorized",
          httpStatusCode: 401,
        },
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => false),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));

    await (controller as any).startTurn({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      binding: {
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: TEST_TELEGRAM_PEER_ID,
        },
        sessionKey: "session-1",
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        updatedAt: Date.now(),
      },
      workspaceDir: "/repo/openclaw",
      prompt: "who are you?",
      reason: "inbound",
    });

    await flushAsyncWork();
    await vi.waitFor(() => {
      expect(sendMessageTelegram).toHaveBeenCalledWith(
        TEST_TELEGRAM_PEER_ID,
        "Codex authentication failed on this machine. Run `codex logout` and `codex login`, then try again.",
        expect.anything(),
      );
    });
    expect(clientMock.readAccount).toHaveBeenCalledWith({
      profile: "default",
      sessionKey: "session-1",
      refreshToken: true,
    });
  });

  it("passes saved conversation preferences into the next Codex turn", async () => {
    const { controller } = await createControllerHarness();
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "done",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => false),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;

    await (controller as any).startTurn({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      binding: {
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: TEST_TELEGRAM_PEER_ID,
        },
        sessionKey: "session-1",
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        permissionsMode: "full-access",
        preferences: {
          preferredModel: "gpt-5.4",
          preferredReasoningEffort: "high",
          preferredServiceTier: "fast",
          updatedAt: Date.now(),
        },
        updatedAt: Date.now(),
      },
      workspaceDir: "/repo/openclaw",
      prompt: "who are you?",
      reason: "inbound",
    });

    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "session-1",
        existingThreadId: "thread-1",
        model: "gpt-5.4",
        reasoningEffort: "high",
        serviceTier: "fast",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      }),
    );
  });

  it("passes saved conversation preferences into review runs", async () => {
    const { controller } = await createControllerHarness();
    const startReview = vi.fn(() => ({
      result: new Promise(() => {}),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => false),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startReview = startReview;

    await (controller as any).startReview({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      binding: {
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: TEST_TELEGRAM_PEER_ID,
        },
        sessionKey: "session-1",
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        permissionsMode: "full-access",
        preferences: {
          preferredModel: "gpt-5.4",
          preferredReasoningEffort: "high",
          preferredServiceTier: "fast",
          updatedAt: Date.now(),
        },
        updatedAt: Date.now(),
      },
      workspaceDir: "/repo/openclaw",
      target: { type: "uncommittedChanges" },
      announceStart: false,
    });

    expect(startReview).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "session-1",
        threadId: "thread-1",
        model: "gpt-5.4",
        reasoningEffort: "high",
        serviceTier: "fast",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      }),
    );
  });

  it("passes saved conversation preferences into plan runs", async () => {
    const { controller } = await createControllerHarness();
    const startTurn = vi.fn(() => ({
      result: new Promise(() => {}),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => false),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;

    await (controller as any).startPlan({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      binding: {
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: TEST_TELEGRAM_PEER_ID,
        },
        sessionKey: "session-1",
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        permissionsMode: "full-access",
        preferences: {
          preferredModel: "gpt-5.4",
          preferredReasoningEffort: "high",
          preferredServiceTier: "fast",
          updatedAt: Date.now(),
        },
        updatedAt: Date.now(),
      },
      workspaceDir: "/repo/openclaw",
      prompt: "plan this",
      announceStart: false,
    });

    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "session-1",
        existingThreadId: "thread-1",
        model: "gpt-5.4",
        reasoningEffort: "high",
        serviceTier: "fast",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        collaborationMode: {
          mode: "plan",
          settings: {
            model: "gpt-5.4",
            reasoningEffort: "high",
            developerInstructions: null,
          },
        },
      }),
    );
  });

  it("recovers the last assistant thread reply before falling back to an empty completion message", async () => {
    const { controller, clientMock } = await createControllerHarness();
    (clientMock.readThreadContext as any).mockImplementation(async () => ({
      lastUserMessage: "who are you?",
      lastAssistantMessage: "Recovered final answer from thread state.",
    }));

    await expect(
      (controller as any).describeEmptyTurnCompletion({
        sessionKey: "session-1",
        profile: "default",
        threadId: "thread-1",
      }),
    ).resolves.toBe("Recovered final answer from thread state.");
  });

  it("keeps empty completed turns generic instead of inferring an auth failure", async () => {
    const { controller, clientMock } = await createControllerHarness();
    (clientMock.readThreadContext as any).mockImplementation(async () => ({
      lastUserMessage: undefined,
      lastAssistantMessage: undefined,
    }));

    await expect(
      (controller as any).describeEmptyTurnCompletion({
        sessionKey: "session-1",
        profile: "default",
        threadId: "thread-1",
      }),
    ).resolves.toBe("Codex completed without a text reply.");
    expect(clientMock.readAccount).not.toHaveBeenCalled();
  });

  it("does not probe auth after an approval cancel completes without assistant text", async () => {
    const { controller, clientMock, sendMessageTelegram } = await createControllerHarness();
    (controller as any).client.startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        stoppedReason: "approval",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => false),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));

    await (controller as any).startTurn({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: TEST_TELEGRAM_PEER_ID,
      },
      binding: {
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: TEST_TELEGRAM_PEER_ID,
        },
        sessionKey: "session-1",
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        updatedAt: Date.now(),
      },
      workspaceDir: "/repo/openclaw",
      prompt: "who are you?",
      reason: "inbound",
    });

    await flushAsyncWork();
    await flushAsyncWork();
    expect(clientMock.readAccount).not.toHaveBeenCalled();
  });

  it("toggles fast mode from the status card and saves preferred service tier", async () => {
    const { controller, clientMock } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "toggle-fast",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    expect(clientMock.setThreadServiceTier).toHaveBeenCalledWith({
      profile: "default",
      sessionKey: "session-1",
      threadId: "thread-1",
      serviceTier: "fast",
    });
    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.preferences?.preferredServiceTier).toBe("fast");
    expect(editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Fast mode: on"),
        buttons: expect.any(Array),
      }),
    );
  });

  it("stores runtime config from Telegram interactive callbacks", async () => {
    const { controller } = await createControllerHarness();
    const callback = await (controller as any).store.putCallback({
      kind: "reply-text",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      text: "runtime-config-ok",
    });
    const config = {
      channels: {
        telegram: {
          botToken: "telegram-token-from-callback",
        },
      },
    };

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      config,
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
      },
    } as any);

    expect((controller as any).lastRuntimeConfig).toEqual(config);
  });

  it("warns when the raw Telegram topic rename fallback returns ok false", async () => {
    const { controller, api } = await createControllerHarness();
    const fetchMock = vi.mocked(fetch);
    delete (api as any).runtime.channel.telegram.conversationActions;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          ok: false,
          description: "Bad Request: not enough rights to manage topics",
        }),
    } as Response);

    await (controller as any).renameConversationIfSupported(
      {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
        threadId: 456,
      },
      "Fresh Thread",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottelegram-token/editForumTopic",
      expect.any(Object),
    );
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("not enough rights to manage topics"),
    );
  });

  it("toggles fast mode from the status card even when the app server returns stale state", async () => {
    const { controller, clientMock } = await createControllerHarness();
    clientMock.setThreadServiceTier.mockImplementation(async () => ({
      threadId: "thread-1",
      threadName: "Discord Thread",
      model: "openai/gpt-5.4",
      cwd: "/repo/openclaw",
      serviceTier: "default",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    }));
    clientMock.readThreadState.mockImplementation(async () => ({
      threadId: "thread-1",
      threadName: "Discord Thread",
      model: "openai/gpt-5.4",
      cwd: "/repo/openclaw",
      serviceTier: "default",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    }));
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "toggle-fast",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.preferences?.preferredServiceTier).toBe("fast");
    expect(editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Fast mode: on"),
        buttons: expect.any(Array),
      }),
    );
  });

  it("stores fast mode as a pending default before the thread is materialized", async () => {
    const { controller, clientMock } = await createControllerHarness();
    clientMock.readThreadState.mockRejectedValue(
      new Error(
        "thread thread-1 is not materialized yet; includeTurns is unavailable before first user message",
      ),
    );
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "toggle-fast",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    expect(clientMock.setThreadServiceTier).not.toHaveBeenCalled();
    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.preferences?.preferredServiceTier).toBe("fast");
    expect(editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Fast mode: on"),
        buttons: expect.any(Array),
      }),
    );
  });

  it("turns fast mode off from the status card by clearing the service tier", async () => {
    const { controller, clientMock } = await createControllerHarness();
    clientMock.readThreadState.mockImplementation(async () => ({
      threadId: "thread-1",
      threadName: "Discord Thread",
      model: "openai/gpt-5.4",
      cwd: "/repo/openclaw",
      serviceTier: "fast",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    }));
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      preferences: {
        preferredServiceTier: "fast",
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "toggle-fast",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    expect(clientMock.setThreadServiceTier).toHaveBeenCalledWith({
      profile: "default",
      sessionKey: "session-1",
      threadId: "thread-1",
      serviceTier: null,
    });
    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.preferences?.preferredServiceTier).toBe("default");
    expect(editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Fast mode: off"),
        buttons: expect.any(Array),
      }),
    );
  });

  it("cycles permissions mode between default and full-access profiles", async () => {
    const { controller, clientMock } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      permissionsMode: "default",
      updatedAt: Date.now(),
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    const first = await (controller as any).store.putCallback({
      kind: "toggle-permissions",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    });
    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: first.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    let binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.permissionsMode).toBe("full-access");
    expect(clientMock.setThreadPermissions).toHaveBeenNthCalledWith(1, {
      profile: "full-access",
      sessionKey: "session-1",
      threadId: "thread-1",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    expect(editMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Permissions: Full Access"),
      }),
    );

    const second = await (controller as any).store.putCallback({
      kind: "toggle-permissions",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    });
    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: second.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.permissionsMode).toBe("default");
    expect(clientMock.setThreadPermissions).toHaveBeenNthCalledWith(2, {
      profile: "default",
      sessionKey: "session-1",
      threadId: "thread-1",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    expect(editMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Permissions: Default"),
      }),
    );
  });

  it("stores permissions mode as a pending default before the thread is materialized", async () => {
    const { controller, clientMock } = await createControllerHarness();
    clientMock.readThreadState.mockRejectedValue(
      new Error(
        "thread thread-1 is not materialized yet; includeTurns is unavailable before first user message",
      ),
    );
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      permissionsMode: "default",
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "toggle-permissions",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    expect(clientMock.setThreadPermissions).not.toHaveBeenCalled();
    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.permissionsMode).toBe("full-access");
    expect(binding?.pendingPermissionsMode).toBeUndefined();
    expect(editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Permissions: Full Access"),
        buttons: expect.any(Array),
      }),
    );
  });

  it("defers permission profile migration until the active run ends", async () => {
    const { controller, clientMock } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      permissionsMode: "default",
      updatedAt: Date.now(),
    });
    const interrupt = vi.fn(async () => {
      (controller as any).activeRuns.delete("telegram::default::123::");
    });
    (controller as any).activeRuns.set("telegram::default::123::", {
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      workspaceDir: "/repo/openclaw",
      mode: "default",
      profile: "default",
      handle: {
        result: Promise.resolve({ threadId: "thread-1", text: "done" }),
        queueMessage: vi.fn(async () => false),
        getThreadId: () => "thread-1",
        interrupt,
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      },
    });
    const callback = await (controller as any).store.putCallback({
      kind: "toggle-permissions",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.permissionsMode).toBe("default");
    expect(binding?.pendingPermissionsMode).toBe("full-access");
    expect(clientMock.setThreadPermissions).not.toHaveBeenCalled();
    expect(editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Permissions note: Full Access will apply after the current Codex turn ends."),
        buttons: expect.any(Array),
      }),
    );
  });

  it("stops the active run from the status card", async () => {
    const { controller, clientMock } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "stop-run",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});
    const interrupt = vi.fn(async () => {
      (controller as any).activeRuns.delete("telegram::default::123::");
    });
    (controller as any).activeRuns.set("telegram::default::123::", {
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      workspaceDir: "/repo/openclaw",
      mode: "default",
      profile: "default",
      handle: {
        result: Promise.resolve({ threadId: "thread-1", text: "done" }),
        queueMessage: vi.fn(async () => false),
        getThreadId: () => "thread-1",
        interrupt,
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      },
    });

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    expect(interrupt).toHaveBeenCalledOnce();
    expect((controller as any).activeRuns.has("telegram::default::123::")).toBe(false);
    expect(clientMock.readThreadState).toHaveBeenCalledWith({
      profile: "default",
      sessionKey: "session-1",
      threadId: "thread-1",
    });
    expect(editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Binding: Discord Thread (openclaw)"),
        buttons: expect.any(Array),
      }),
    );
  });

  it("keeps default permissions and explains when Full Access is unavailable", async () => {
    const { controller, clientMock } = await createControllerHarness();
    clientMock.hasProfile.mockImplementation((profile: string) => profile === "default");
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      permissionsMode: "default",
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "toggle-permissions",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.permissionsMode).toBe("default");
    expect(clientMock.setThreadPermissions).not.toHaveBeenCalled();
    expect(editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Permissions: Default"),
        buttons: expect.any(Array),
      }),
    );
    expect(editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining(
          "Permissions note: Full Access is unavailable in the current Codex Desktop session",
        ),
      }),
    );
  });

  it("shows model-picker buttons in place from the status card callback", async () => {
    const { controller, sendMessageTelegram } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "show-model-picker",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token, messageId: 41, chatId: "123" },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    expect(sendMessageTelegram).not.toHaveBeenCalled();
    const lastCall = editMessage.mock.calls.at(-1)?.[0] as
      | { text?: string; buttons?: Array<Array<{ text: string; callback_data: string }>> }
      | undefined;
    expect(lastCall?.text).toContain("Binding:");
    expect(Array.isArray(lastCall?.buttons)).toBe(true);
    expect(lastCall?.buttons?.some((row) => row[0]?.text === "Cancel")).toBe(true);
    const firstToken = String(lastCall?.buttons?.[0]?.[0]?.callback_data ?? "").split(":").pop() ?? "";
    expect((controller as any).store.getCallback(firstToken)).toEqual(
      expect.objectContaining({
        kind: "set-model",
        returnToStatus: true,
      }),
    );
    const cancelToken = String(
      lastCall?.buttons
        ?.flat()
        .find((button) => button.text === "Cancel")
        ?.callback_data ?? "",
    ).split(":").pop();
    expect((controller as any).store.getCallback(cancelToken)).toEqual(
      expect.objectContaining({
        kind: "refresh-status",
      }),
    );
  });

  it("shows reasoning-picker buttons from the status card callback", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "show-reasoning-picker",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token, messageId: 41, chatId: "123" },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    const lastCall = editMessage.mock.calls.at(-1)?.[0] as any;
    expect(lastCall?.text).toContain("Binding:");
    expect(lastCall?.buttons?.some((row: Array<{ text: string }>) => row[0]?.text === "High")).toBe(true);
    expect(lastCall?.buttons?.some((row: Array<{ text: string }>) => row[0]?.text === "Cancel")).toBe(true);
    const cancelToken = String(
      lastCall?.buttons
        ?.flat()
        .find((button: { text: string }) => button.text === "Cancel")
        ?.callback_data ?? "",
    )
      .split(":")
      .pop();
    expect((controller as any).store.getCallback(cancelToken)).toEqual(
      expect.objectContaining({
        kind: "refresh-status",
      }),
    );
  });

  it("shows reasoning-picker buttons for an unmaterialized thread using the current default model", async () => {
    const { controller, clientMock } = await createControllerHarness();
    clientMock.readThreadState.mockRejectedValue(
      new Error(
        "thread thread-1 is not materialized yet; includeTurns is unavailable before first user message",
      ),
    );
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "show-reasoning-picker",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token, messageId: 41, chatId: "123" },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    const lastCall = editMessage.mock.calls.at(-1)?.[0] as any;
    expect(lastCall?.text).toContain("Binding:");
    expect(lastCall?.text).toContain("saved as defaults until then");
    expect(lastCall?.buttons?.some((row: Array<{ text: string }>) => row[0]?.text === "High")).toBe(true);
    expect(lastCall?.buttons?.some((row: Array<{ text: string }>) => row[0]?.text === "Cancel")).toBe(true);
  });

  it("shows the model picker in a separate message using the saved preferred model when the thread snapshot is stale", async () => {
    const { controller, clientMock, sendMessageTelegram } = await createControllerHarness();
    clientMock.readThreadState.mockImplementation(async () => ({
      threadId: "thread-1",
      threadName: "Discord Thread",
      model: "openai/gpt-5.4",
      cwd: "/repo/openclaw",
      serviceTier: "default",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    }));
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      preferences: {
        preferredModel: "openai/gpt-5.3",
        preferredServiceTier: null,
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "show-model-picker",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    expect(editMessage).not.toHaveBeenCalled();
    const pickerCall = sendMessageTelegram.mock.calls.at(-1) as unknown as
      | [string, string, { buttons?: Array<Array<{ text: string }>> }]
      | undefined;
    expect(pickerCall?.[0]).toBe("123");
    expect(pickerCall?.[1]).toContain("Current model: openai/gpt-5.3");
    expect(pickerCall?.[2]?.buttons?.some((row) => row[0]?.text === "openai/gpt-5.3 (current)")).toBe(true);
  });

  it("sets the model from the status picker and returns to the updated status card", async () => {
    const { controller, clientMock } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "set-model",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      model: "openai/gpt-5.3",
      returnToStatus: true,
    });
    const reply = vi.fn(async () => {});
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply,
        editMessage,
      },
    } as any);

    expect(clientMock.setThreadModel).toHaveBeenCalledWith({
      profile: "default",
      sessionKey: "session-1",
      threadId: "thread-1",
      model: "openai/gpt-5.3",
    });
    expect(reply).not.toHaveBeenCalled();
    expect(editMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Model: openai/gpt-5.3"),
        buttons: expect.any(Array),
      }),
    );
  });

  it("sets the reasoning from the status picker and returns to the updated status card", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "set-reasoning",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      reasoningEffort: "high",
      returnToStatus: true,
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.preferences?.preferredReasoningEffort).toBe("high");
    expect(editMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Model: openai/gpt-5.4 · reasoning high"),
        buttons: expect.any(Array),
      }),
    );
  });

  it("starts compaction from the status card", async () => {
    const { controller } = await createControllerHarness();
    const startCompact = vi.fn(async () => {});
    (controller as any).startCompact = startCompact;
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      contextUsage: {
        totalTokens: 221_946,
        contextWindow: 258_400,
        remainingPercent: 14,
      },
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "compact-thread",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    expect(startCompact).toHaveBeenCalledWith({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
        threadId: undefined,
      },
      binding: expect.objectContaining({
        sessionKey: "session-1",
        threadId: "thread-1",
      }),
    });
    expect(editMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Compaction started."),
        buttons: expect.any(Array),
      }),
    );
  });

  it("refuses compaction from the status card when the rebound thread has no materialized context", async () => {
    const { controller } = await createControllerHarness();
    const startCompact = vi.fn(async () => {});
    (controller as any).startCompact = startCompact;
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      contextUsage: null,
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "compact-thread",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    expect(startCompact).not.toHaveBeenCalled();
    expect(editMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("has no materialized context yet"),
        buttons: expect.any(Array),
      }),
    );
  });

  it("runs skills from the status card without rewriting the status message", async () => {
    const { controller, sendMessageTelegram } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "show-skills",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    expect(editMessage).not.toHaveBeenCalled();
    const pickerCall = sendMessageTelegram.mock.calls.at(-1) as unknown as
      | [string, string, { buttons?: Array<Array<{ text: string }>> }]
      | undefined;
    expect(pickerCall?.[0]).toBe("123");
    expect(pickerCall?.[1]).toContain("Type `$skill-name` in this chat to run one directly.");
    expect(pickerCall?.[2]?.buttons?.flat().map((button) => button.text)).toEqual(
      expect.arrayContaining(["$skill-a", "$skill-b", "Mode: toggle", "Cancel"]),
    );
  });

  it("toggles skills picker into help mode and prints help without rewriting the picker", async () => {
    const { controller, sendMessageTelegram } = await createControllerHarness();
    const helpView = await (controller as any).store.putCallback({
      kind: "picker-view",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      view: {
        mode: "skills",
        page: 0,
        clickMode: "help",
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: helpView.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    expect(editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Mode: Click to Print Help. Page 1/1."),
        buttons: expect.any(Array),
      }),
    );
    const helpCallback = await (controller as any).store.putCallback({
      kind: "show-skill-help",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      skillName: "skill-a",
      description: "Skill A",
      cwd: "/repo/openclaw",
      enabled: true,
    });

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: helpCallback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    expect(editMessage).toHaveBeenCalledTimes(1);
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "123",
      expect.stringContaining("Skill: $skill-a"),
      expect.objectContaining({
        accountId: "default",
      }),
    );
  });

  it("runs MCPs from the status card without rewriting the status message", async () => {
    const { controller, sendMessageTelegram } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "show-mcp",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    expect(editMessage).not.toHaveBeenCalled();
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "123",
      expect.stringContaining("No MCP servers reported."),
      expect.objectContaining({
        accountId: "default",
      }),
    );
  });

  it("sets the model from the status picker using the requested model when the app server returns stale state", async () => {
    const { controller, clientMock } = await createControllerHarness();
    clientMock.setThreadModel.mockImplementation(async () => ({
      threadId: "thread-1",
      threadName: "Discord Thread",
      model: "openai/gpt-5.4",
      cwd: "/repo/openclaw",
      serviceTier: "default",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    }));
    clientMock.readThreadState.mockImplementation(async () => ({
      threadId: "thread-1",
      threadName: "Discord Thread",
      model: "openai/gpt-5.4",
      cwd: "/repo/openclaw",
      serviceTier: "default",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    }));
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "set-model",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      model: "openai/gpt-5.3",
      returnToStatus: true,
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.preferences?.preferredModel).toBe("openai/gpt-5.3");
    expect(editMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Model: openai/gpt-5.3"),
        buttons: expect.any(Array),
      }),
    );
  });

  it("stores the selected model as a pending default before the thread is materialized", async () => {
    const { controller, clientMock } = await createControllerHarness();
    clientMock.readThreadState.mockRejectedValue(
      new Error(
        "thread thread-1 is not materialized yet; includeTurns is unavailable before first user message",
      ),
    );
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "set-model",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      model: "openai/gpt-5.3",
      returnToStatus: true,
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    expect(clientMock.setThreadModel).not.toHaveBeenCalled();
    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.preferences?.preferredModel).toBe("openai/gpt-5.3");
    expect(editMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Model: openai/gpt-5.3"),
        buttons: expect.any(Array),
      }),
    );
  });

  it("clears fast mode when switching to a model that does not support it", async () => {
    const { controller, clientMock } = await createControllerHarness();
    clientMock.setThreadModel.mockImplementation(async () => ({
      threadId: "thread-1",
      threadName: "Discord Thread",
      model: "openai/gpt-5.4",
      cwd: "/repo/openclaw",
      serviceTier: "fast",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    }));
    clientMock.readThreadState.mockImplementation(async () => ({
      threadId: "thread-1",
      threadName: "Discord Thread",
      model: "openai/gpt-5.4",
      cwd: "/repo/openclaw",
      serviceTier: "default",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    }));
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      preferences: {
        preferredModel: "openai/gpt-5.4",
        preferredServiceTier: "fast",
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "set-model",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      model: "gpt-5.3-codex-spark",
      returnToStatus: true,
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: { payload: callback.token },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    expect(clientMock.setThreadServiceTier).toHaveBeenCalledWith({
      profile: "default",
      sessionKey: "session-1",
      threadId: "thread-1",
      serviceTier: null,
    });
    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.preferences?.preferredModel).toBe("gpt-5.3-codex-spark");
    expect(binding?.preferences?.preferredServiceTier).toBe("default");
    expect(editMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Model: gpt-5.3-codex-spark"),
        buttons: expect.any(Array),
      }),
    );
  });

  it("dismisses the picker when cancel-picker callback is pressed", async () => {
    const { controller } = await createControllerHarness();
    const callback = await (controller as any).store.putCallback({
      kind: "cancel-picker",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
    });
    const acknowledge = vi.fn(async () => {});
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleDiscordInteractive({
      channel: "discord",
      accountId: "default",
      interactionId: "interaction-1",
      conversationId: "channel:chan-1",
      auth: { isAuthorizedSender: true },
      interaction: {
        kind: "button",
        data: `codexapp:${callback.token}`,
        namespace: "codexapp",
        payload: callback.token,
        messageId: "message-1",
      },
      senderId: "user-1",
      senderUsername: "Ada",
      respond: {
        acknowledge,
        reply: vi.fn(async () => {}),
        followUp: vi.fn(async () => {}),
        editMessage,
        clearComponents: vi.fn(async () => {}),
      },
    } as any);

    // editPicker uses ctx.respond.editMessage first; when that succeeds it calls
    // registerBuiltDiscordComponentMessage instead of editDiscordComponentMessage
    expect(editMessage).toHaveBeenCalledTimes(1);
    expect(discordSdkState.registerBuiltDiscordComponentMessage).toHaveBeenCalledWith({
      buildResult: expect.objectContaining({
        components: expect.any(Array),
        entries: expect.any(Array),
      }),
      messageId: "message-1",
    });
    // The callback should be removed from the store
    expect((controller as any).store.getCallback(callback.token)).toBeNull();
  });

  it("updates task-card fields through cas_task and renders them in cas_status", async () => {
    const { controller, sendMessageTelegram } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });

    const goalReply = await controller.handleCommand("cas_task", buildTelegramCommandContext({
      args: "goal Ship the prod-safe cockpit task card",
      commandBody: "/cas_task goal Ship the prod-safe cockpit task card",
      getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
    }));
    const stageReply = await controller.handleCommand("cas_task", buildTelegramCommandContext({
      args: "stage executing",
      commandBody: "/cas_task stage executing",
      getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
    }));
    const nextReply = await controller.handleCommand("cas_task", buildTelegramCommandContext({
      args: "next Run the prod smoke checks",
      commandBody: "/cas_task next Run the prod smoke checks",
      getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
    }));
    const evidenceReply = await controller.handleCommand("cas_task", buildTelegramCommandContext({
      args: "evidence Local vitest is green",
      commandBody: "/cas_task evidence Local vitest is green",
      getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
    }));
    const blockerReply = await controller.handleCommand("cas_task", buildTelegramCommandContext({
      args: "blocker Waiting for the Telegram reply path",
      commandBody: "/cas_task blocker Waiting for the Telegram reply path",
      getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
    }));

    expect(goalReply.text).toContain("Goal: Ship the prod-safe cockpit task card");
    expect(stageReply.text).toContain("Stage: executing");
    expect(nextReply.text).toContain("Next action: Run the prod smoke checks");
    expect(evidenceReply.text).toContain("Latest evidence: Local vitest is green");
    expect(blockerReply.text).toContain("Blocker: Waiting for the Telegram reply path");

    const statusReply = await controller.handleCommand("cas_status", buildTelegramCommandContext({
      commandBody: "/cas_status",
      getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
    }));

    expect(statusReply).toEqual({});
    expect(sendMessageTelegram).toHaveBeenLastCalledWith(
      "123",
      expect.stringContaining("Task card:"),
      expect.objectContaining({
        accountId: "default",
        buttons: expect.any(Array),
      }),
    );
    const lastStatusText = sendMessageTelegram.mock.calls.at(-1)?.[1] as string;
    expect(lastStatusText).toContain("Goal: Ship the prod-safe cockpit task card");
    expect(lastStatusText).toContain("Stage: executing");
    expect(lastStatusText).toContain("Next action: Run the prod smoke checks");
    expect(lastStatusText).toContain("Latest evidence: Local vitest is green");
    expect(lastStatusText).toContain("Blocker: Waiting for the Telegram reply path");
  });

  it("stores verification and checkpoint state through cas_verify and cas_checkpoint", async () => {
    const { controller, sendMessageTelegram } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });

    const verifyReply = await controller.handleCommand("cas_verify", buildTelegramCommandContext({
      args: "verified Local tests and host-side typecheck passed",
      commandBody: "/cas_verify verified Local tests and host-side typecheck passed",
      getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
    }));
    const checkpointReply = await controller.handleCommand("cas_checkpoint", buildTelegramCommandContext({
      args: "save Runtime artifact is ready --next Copy to ~/.openclaw/extensions and run /cas_status",
      commandBody: "/cas_checkpoint save Runtime artifact is ready --next Copy to ~/.openclaw/extensions and run /cas_status",
      getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
    }));

    expect(verifyReply.text).toContain("Verification: Verified");
    expect(verifyReply.text).toContain("Local tests and host-side typecheck passed");
    expect(checkpointReply.text).toContain("Checkpoint: Runtime artifact is ready");
    expect(checkpointReply.text).toContain("Checkpoint next: Copy to ~/.openclaw/extensions and run /cas_status");

    const statusReply = await controller.handleCommand("cas_status", buildTelegramCommandContext({
      commandBody: "/cas_status",
      getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
    }));

    expect(statusReply).toEqual({});
    const lastStatusText = sendMessageTelegram.mock.calls.at(-1)?.[1] as string;
    expect(lastStatusText).toContain("Verification: Verified");
    expect(lastStatusText).toContain("Verification summary: Local tests and host-side typecheck passed");
    expect(lastStatusText).toContain("Checkpoint: Runtime artifact is ready");
    expect(lastStatusText).toContain("Checkpoint next: Copy to ~/.openclaw/extensions and run /cas_status");
  });

  it("refreshes a pinned Telegram status card in place after task-state updates", async () => {
    const { controller } = await createControllerHarness();
    const updateStatusCardMessage = vi.spyOn(controller as any, "updateStatusCardMessage");
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
        threadId: 456,
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      pinnedBindingMessage: {
        provider: "telegram",
        messageId: "99",
        chatId: "123",
      },
      updatedAt: Date.now(),
    });

    await (controller as any).upsertTaskState(
      (controller as any).store.getBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      }),
      {
        goal: "Ship the long-lived cockpit flow",
      },
    );

    expect(updateStatusCardMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        conversationId: "123:topic:456",
      }),
      {
        provider: "telegram",
        messageId: "99",
        chatId: "123",
      },
      expect.objectContaining({
        text: expect.stringContaining("Goal: Ship the long-lived cockpit flow"),
      }),
    );
  });

  it("resumes a task from the status card without overwriting the existing goal", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      taskState: {
        goal: "Ship the long-lived cockpit flow",
        stage: "blocked",
        nextAction: "Resume from the last checkpoint",
        blocker: "Codex stopped before completion",
        checkpoint: {
          summary: "Turn interrupted before completion",
          nextAction: "Restart or steer the task",
          savedAt: Date.now(),
        },
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "resume-task",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
    });
    const startTurn = vi.fn(() => ({
      result: new Promise(() => {}),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;
    const editMessage = vi.fn(async (_payload: any) => {});
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          success: true,
          data: [
            'ID: 460 | Evgeny "Chip" | Date: 2026-04-12 12:16:03+00:00 | reply to 456 | Message: Keep the last Telegram asks in recovery',
            'ID: 456 | Evgeny "Chip" | Date: 2026-04-12 12:10:00+00:00 | Message: Resume this exact thread after the crash',
          ].join("\n"),
        }),
    } as Response);

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123:topic:456",
      parentConversationId: "123",
      threadId: 456,
      callback: {
        payload: callback.token,
      },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("Resume the current Codex task from the existing long-lived thread context."),
      input: [
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("Keep the last Telegram asks in recovery"),
        }),
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("Resume the current Codex task from the existing long-lived thread context."),
        }),
      ],
    }));
    expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("Goal: Ship the long-lived cockpit flow"),
    }));
    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123:topic:456",
      parentConversationId: "123",
    });
    expect(binding?.taskState?.goal).toBe("Ship the long-lived cockpit flow");
    expect(binding?.taskState?.stage).toBe("executing");
    expect(editMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Resuming Codex from the latest checkpoint."),
    }));
  });

  it("marks a task verified from the status card", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      taskState: {
        goal: "Ship the long-lived cockpit flow",
        stage: "verifying",
        nextAction: "Review the latest Codex result",
        latestEvidence: "Controller tests passed for the pinned refresh path.",
        verification: {
          status: "unverified",
          updatedAt: Date.now(),
        },
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "mark-verified",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123:topic:456",
      parentConversationId: "123",
      threadId: 456,
      callback: {
        payload: callback.token,
      },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123:topic:456",
      parentConversationId: "123",
    });
    expect(binding?.taskState?.stage).toBe("done");
    expect(binding?.taskState?.verification?.status).toBe("verified");
    expect(binding?.taskState?.verification?.summary).toBe("Controller tests passed for the pinned refresh path.");
    expect(binding?.taskState?.resumeReason).toBe("Send the next task message in this thread");
    expect(typeof binding?.taskState?.lastVerifiedAt).toBe("number");
    expect(editMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Marked this task as verified."),
    }));
  });

  it("clears the current blocker from the status card", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      taskState: {
        goal: "Ship the long-lived cockpit flow",
        stage: "blocked",
        nextAction: "Restart or steer the task",
        blocker: "Codex stopped before completion",
        checkpoint: {
          summary: "Turn interrupted before completion",
          nextAction: "Restart or steer the task",
          savedAt: Date.now(),
        },
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "clear-task-blocker",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
    });
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123:topic:456",
      parentConversationId: "123",
      threadId: 456,
      callback: {
        payload: callback.token,
      },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage,
      },
    } as any);

    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123:topic:456",
      parentConversationId: "123",
    });
    expect(binding?.taskState?.blocker).toBeUndefined();
    expect(binding?.taskState?.checkpoint).toBeUndefined();
    expect(binding?.taskState?.stage).toBe("executing");
    expect(editMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Cleared the current blocker."),
    }));
  });

  it("marks verification stale when a verified task receives file edits in a new run", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      taskState: {
        stage: "verifying",
        verification: {
          status: "verified",
          summary: "Baseline checks passed",
          updatedAt: Date.now() - 60_000,
        },
        updatedAt: Date.now() - 60_000,
      },
      updatedAt: Date.now() - 60_000,
    });

    (controller as any).client.startTurn = vi.fn((params: any) => {
      void Promise.resolve().then(() => params.onFileEdits?.("Edited files: src/controller.ts"));
      return {
        result: Promise.resolve({
          threadId: "thread-1",
          text: "done",
        }),
        getThreadId: () => "thread-1",
        queueMessage: vi.fn(async () => false),
        interrupt: vi.fn(async () => {}),
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      };
    });

    await (controller as any).startTurn({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      binding: (controller as any).store.getBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      }),
      workspaceDir: "/repo/openclaw",
      prompt: "Ship the cockpit diff",
      reason: "command",
    });

    await vi.waitFor(() => {
      const binding = (controller as any).store.getBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      });
      expect(binding?.taskState?.verification?.status).toBe("stale");
      expect(binding?.taskState?.latestEvidence).toBe("Edited files: src/controller.ts");
      expect(binding?.taskState?.lastRunSummary).toBe("Edited files: src/controller.ts");
      expect(binding?.taskState?.resumeReason).toBe("Wait for Codex to finish applying changes");
    });
  });

  it("auto-seeds the current task card from a natural top-level prompt", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });

    (controller as any).client.startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "Implemented the status card changes.",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => false),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));

    await (controller as any).startTurn({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      binding: (controller as any).store.getBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      }),
      workspaceDir: "/repo/openclaw",
      prompt: "Fix the cockpit status rendering for long-lived chipcdx flow threads",
      reason: "command",
    });

    await vi.waitFor(() => {
      const binding = (controller as any).store.getBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      });
      expect(binding?.taskState?.goal).toContain("Fix the cockpit status rendering");
      expect(binding?.taskState?.stage).toBe("verifying");
      expect(binding?.taskState?.nextAction).toBe("Review the latest Codex result");
      expect(binding?.taskState?.verification?.status).toBe("unverified");
      expect(binding?.taskState?.latestEvidence).toContain("Implemented the status card changes.");
      expect(binding?.taskState?.lastRunSummary).toContain("Implemented the status card changes.");
      expect(binding?.taskState?.resumeReason).toBe("Review the latest Codex result");
    });
  });

  it("auto-verifies strong completion evidence and records the resume ledger", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });

    (controller as any).client.startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "Tests passed. Typecheck passed. Build passed.",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => false),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));

    await (controller as any).startTurn({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      binding: (controller as any).store.getBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      }),
      workspaceDir: "/repo/openclaw",
      prompt: "Finish the cockpit runtime verification slice",
      reason: "command",
    });

    await vi.waitFor(() => {
      const binding = (controller as any).store.getBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      });
      expect(binding?.taskState?.stage).toBe("done");
      expect(binding?.taskState?.verification?.status).toBe("verified");
      expect(binding?.taskState?.verification?.summary).toContain("Tests passed");
      expect(binding?.taskState?.lastRunSummary).toContain("Tests passed");
      expect(binding?.taskState?.resumeReason).toBe("Send the next task message in this thread");
      expect(typeof binding?.taskState?.lastVerifiedAt).toBe("number");
    });
  });

  it("auto-updates the task card from plan mode without manual task commands", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });

    (controller as any).client.startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        planArtifact: {
          explanation: "Break the work into a small prod-safe slice.",
          steps: [
            { step: "Patch status rendering", status: "completed" },
            { step: "Run host-side tests", status: "inProgress" },
          ],
          markdown: "# Plan",
        },
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => false),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));

    await (controller as any).startPlan({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      binding: (controller as any).store.getBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      }),
      workspaceDir: "/repo/openclaw",
      prompt: "Plan the next prod-safe cockpit improvement",
      announceStart: false,
    });

    await vi.waitFor(() => {
      const binding = (controller as any).store.getBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      });
      expect(binding?.taskState?.goal).toContain("Plan the next prod-safe cockpit improvement");
      expect(binding?.taskState?.stage).toBe("planned");
      expect(binding?.taskState?.latestEvidence).toBe("Break the work into a small prod-safe slice.");
      expect(binding?.taskState?.lastRunSummary).toBe("Break the work into a small prod-safe slice.");
      expect(binding?.taskState?.nextAction).toBe("Run host-side tests");
      expect(binding?.taskState?.resumeReason).toBe("Run host-side tests");
    });
  });

  it("captures pending questionnaire state as a blocker and checkpoint", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });

    let resolveResult: ((value: unknown) => void) | undefined;
    const result = new Promise((resolve) => {
      resolveResult = resolve;
    });
    (controller as any).client.startTurn = vi.fn((params: any) => {
      void Promise.resolve().then(() =>
        params.onPendingInput?.({
          requestId: "req-1",
          options: [],
          expiresAt: Date.now() + 60_000,
          method: "item/tool/requestUserInput",
          questionnaire: {
            currentIndex: 0,
            questions: [
              {
                index: 0,
                id: "scope",
                header: "Scope",
                prompt: "Which path should Codex take?",
                options: [
                  { key: "A", label: "Safe", description: "Small prod-safe slice." },
                ],
                guidance: [],
                allowFreeform: true,
              },
            ],
            answers: [null],
            responseMode: "structured",
          },
        }),
      );
      return {
        result,
        getThreadId: () => "thread-1",
        queueMessage: vi.fn(async () => false),
        interrupt: vi.fn(async () => {}),
        isAwaitingInput: () => true,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      };
    });

    await (controller as any).startTurn({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      binding: (controller as any).store.getBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      }),
      workspaceDir: "/repo/openclaw",
      prompt: "Continue the chipcdx production task",
      reason: "command",
    });

    await vi.waitFor(() => {
      const binding = (controller as any).store.getBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      });
      expect(binding?.taskState?.stage).toBe("clarifying");
      expect(binding?.taskState?.nextAction).toBe("Answer the current Codex questionnaire");
      expect(binding?.taskState?.blocker).toBe("Codex is waiting for questionnaire answers");
      expect(binding?.taskState?.resumeReason).toBe("Answer the current Codex questionnaire");
      expect(binding?.taskState?.checkpoint?.summary).toBe("Codex asked a questionnaire");
      expect(binding?.taskState?.checkpoint?.nextAction).toBe("Answer the current Codex questionnaire");
    });

    resolveResult?.({
      threadId: "thread-1",
      aborted: true,
      terminalStatus: "interrupted",
    });
  });

  it("edits the questionnaire in place for free-form answers without sending an extra Telegram reply", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertPendingRequest({
      requestId: "questionnaire-freeform-1",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      state: {
        requestId: "questionnaire-freeform-1",
        options: [],
        expiresAt: Date.now() + 60_000,
        method: "item/tool/requestUserInput",
        questionnaire: {
          currentIndex: 0,
          questions: [
            {
              index: 0,
              id: "scope",
              header: "Scope",
              prompt: "Which path should Codex take?",
              options: [{ key: "A", label: "Safe", description: "Small prod-safe slice." }],
              guidance: [],
              allowFreeform: true,
            },
          ],
          answers: [null],
          responseMode: "structured",
        },
      },
      updatedAt: Date.now(),
    });
    const conversation = {
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    } as const;
    (controller as any).activeRuns.set(buildConversationKey(conversation), {
      conversation,
      workspaceDir: "/repo/openclaw",
      mode: "plan",
      profile: "default",
      handle: {
        queueMessage: vi.fn(async () => false),
        interrupt: vi.fn(async () => {}),
        isAwaitingInput: () => true,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      },
    });
    const callback = await (controller as any).store.putCallback({
      kind: "pending-questionnaire",
      conversation,
      requestId: "questionnaire-freeform-1",
      questionIndex: 0,
      action: "freeform",
    });
    const reply = vi.fn(async () => {});
    const editMessage = vi.fn(async (_payload: any) => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
      callback: {
        payload: callback.token,
        messageId: "10",
        chatId: "123",
      },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply,
        editMessage,
      },
    } as any);

    expect(reply).not.toHaveBeenCalled();
    expect(editMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("Current answer: waiting for your free-form reply"),
    }));
  });

  it("clears pending questionnaire blockers once the turn resumes", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });

    let resolveResult: ((value: unknown) => void) | undefined;
    const result = new Promise((resolve) => {
      resolveResult = resolve;
    });
    (controller as any).client.startTurn = vi.fn((params: any) => {
      void Promise.resolve()
        .then(() =>
          params.onPendingInput?.({
            requestId: "req-1",
            options: [],
            expiresAt: Date.now() + 60_000,
            method: "item/tool/requestUserInput",
            questionnaire: {
              currentIndex: 0,
              questions: [
                {
                  index: 0,
                  id: "scope",
                  header: "Scope",
                  prompt: "Which path should Codex take?",
                  options: [{ key: "A", label: "Safe", description: "Small prod-safe slice." }],
                  guidance: [],
                  allowFreeform: true,
                },
              ],
              answers: [null],
              responseMode: "structured",
            },
          }),
        )
        .then(() => params.onPendingInput?.(null));
      return {
        result,
        getThreadId: () => "thread-1",
        queueMessage: vi.fn(async () => false),
        interrupt: vi.fn(async () => {}),
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      };
    });

    await (controller as any).startTurn({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      binding: (controller as any).store.getBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      }),
      workspaceDir: "/repo/openclaw",
      prompt: "Continue the chipcdx production task",
      reason: "command",
    });

    await vi.waitFor(() => {
      const binding = (controller as any).store.getBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      });
      expect(binding?.taskState?.stage).toBe("executing");
      expect(binding?.taskState?.nextAction).toBe("Wait for Codex to finish the current turn");
      expect(binding?.taskState?.blocker).toBeUndefined();
      expect(binding?.taskState?.checkpoint).toBeUndefined();
      expect(binding?.taskState?.resumeReason).toBe("Wait for Codex to finish the current turn");
    });

    resolveResult?.({
      threadId: "thread-1",
      aborted: true,
      terminalStatus: "interrupted",
    });
  });

  it("clears pending plan blockers once plan mode resumes", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });

    let resolveResult: ((value: unknown) => void) | undefined;
    const result = new Promise((resolve) => {
      resolveResult = resolve;
    });
    (controller as any).client.startTurn = vi.fn((params: any) => {
      void Promise.resolve()
        .then(() =>
          params.onPendingInput?.({
            requestId: "req-1",
            options: [],
            expiresAt: Date.now() + 60_000,
            method: "item/tool/requestUserInput",
            questionnaire: {
              currentIndex: 0,
              questions: [
                {
                  index: 0,
                  id: "scope",
                  header: "Scope",
                  prompt: "Which path should Codex take?",
                  options: [{ key: "A", label: "Safe", description: "Small prod-safe slice." }],
                  guidance: [],
                  allowFreeform: true,
                },
              ],
              answers: [null],
              responseMode: "structured",
            },
          }),
        )
        .then(() => params.onPendingInput?.(null));
      return {
        result,
        getThreadId: () => "thread-1",
        queueMessage: vi.fn(async () => false),
        interrupt: vi.fn(async () => {}),
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      };
    });

    await (controller as any).startPlan({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      workspaceDir: "/repo/openclaw",
      prompt: "Plan the next prod-safe cockpit improvement",
      binding: (controller as any).store.getBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      }),
      reason: "command",
    });

    await vi.waitFor(() => {
      const binding = (controller as any).store.getBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      });
      expect(binding?.taskState?.stage).toBe("planned");
      expect(binding?.taskState?.nextAction).toBe("Wait for Codex to finish the current plan");
      expect(binding?.taskState?.blocker).toBeUndefined();
      expect(binding?.taskState?.checkpoint).toBeUndefined();
      expect(binding?.taskState?.resumeReason).toBe("Wait for Codex to finish the current plan");
    });

    resolveResult?.({
      threadId: "thread-1",
      aborted: true,
      terminalStatus: "interrupted",
    });
  });

  it("captures approval pauses as a resumable checkpoint", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });

    (controller as any).client.startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        stoppedReason: "approval",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => false),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));

    await (controller as any).startTurn({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      binding: (controller as any).store.getBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      }),
      workspaceDir: "/repo/openclaw",
      prompt: "Continue the chipcdx production task",
      reason: "command",
    });

    await vi.waitFor(() => {
      const binding = (controller as any).store.getBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      });
      expect(binding?.taskState?.stage).toBe("clarifying");
      expect(binding?.taskState?.nextAction).toBe("Review or approve the pending Codex action");
      expect(binding?.taskState?.blocker).toBe("Codex paused for approval");
      expect(binding?.taskState?.resumeReason).toBe("Review or approve the pending Codex action");
      expect(binding?.taskState?.checkpoint?.summary).toBe("Codex paused for approval");
      expect(binding?.taskState?.checkpoint?.nextAction).toBe("Review or approve the pending Codex action");
    });
  });

  it("captures interrupted turns as blocked checkpoints", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });

    (controller as any).client.startTurn = vi.fn((params: any) => {
      void Promise.resolve().then(() => params.onInterrupted?.());
      return {
        result: Promise.resolve({
          threadId: "thread-1",
          aborted: true,
          terminalStatus: "interrupted",
        }),
        getThreadId: () => "thread-1",
        queueMessage: vi.fn(async () => false),
        interrupt: vi.fn(async () => {}),
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      };
    });

    await (controller as any).startTurn({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      binding: (controller as any).store.getBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      }),
      workspaceDir: "/repo/openclaw",
      prompt: "Continue the chipcdx production task",
      reason: "command",
    });

    await vi.waitFor(() => {
      const binding = (controller as any).store.getBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      });
      expect(binding?.taskState?.stage).toBe("blocked");
      expect(binding?.taskState?.nextAction).toBe("Restart or steer the task");
      expect(binding?.taskState?.blocker).toBe("Codex stopped before completion");
      expect(binding?.taskState?.lastFailure).toBe("Turn interrupted before completion");
      expect(binding?.taskState?.resumeReason).toBe("Restart or steer the task");
      expect(binding?.taskState?.checkpoint?.summary).toBe("Turn interrupted before completion");
      expect(binding?.taskState?.checkpoint?.nextAction).toBe("Restart or steer the task");
    });
  });

  it("falls back to TELEGRAM_BOT_TOKEN when runtime config is unavailable", async () => {
    const { api, resolveTelegramToken } = createApiMock();
    resolveTelegramToken.mockImplementation(() => undefined as any);
    const controller = new CodexPluginController(api);
    await controller.start();
    const previous = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "env-telegram-token";
    try {
      (controller as any).getOpenClawConfig = vi.fn(() => undefined);
      await expect((controller as any).resolveTelegramBotToken("default")).resolves.toBe(
        "env-telegram-token",
      );
    } finally {
      if (previous === undefined) {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = previous;
      }
    }
  });

  it("does not announce 'Codex stopped.' when controller shutdown interrupts an active run", async () => {
    const harness = createApiMock();
    const controller = new CodexPluginController(harness.api);
    await (controller as any).store.load();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      taskState: {
        stage: "planned",
        goal: "Resume the current production task",
        nextAction: "Continue the current production task",
        lastHeartbeatAt: Date.now(),
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    });

    let interrupted: (() => Promise<void>) | undefined;
    const clientMock = {
      hasProfile: vi.fn((profile: string) => profile === "default" || profile === "full-access"),
      logStartupProbe: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
      listModels: vi.fn(async () => [{ id: "openai/gpt-5.4", current: true }]),
      readThreadState: vi.fn(async () => ({
        threadId: "thread-1",
        threadName: "Recovered Thread",
        model: "openai/gpt-5.4",
        cwd: "/repo/openclaw",
        serviceTier: "default",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      })),
      readThreadContext: vi.fn(async () => ({
        lastUserMessage: "resume this",
        lastAssistantMessage: undefined,
      })),
      readAccount: vi.fn(async () => ({
        email: "test@example.com",
        planType: "pro",
        type: "chatgpt",
      })),
      readRateLimits: vi.fn(async () => []),
      startTurn: vi.fn((params: any) => {
        interrupted = async () => {
          await params.onInterrupted?.();
        };
        return {
          result: new Promise(() => {}),
          getThreadId: () => "thread-1",
          queueMessage: vi.fn(async () => false),
          interrupt: vi.fn(async () => {
            await interrupted?.();
          }),
          isAwaitingInput: () => false,
          submitPendingInput: vi.fn(async () => false),
          submitPendingInputPayload: vi.fn(async () => false),
        };
      }),
    };
    (controller as any).client = clientMock;

    await controller.start();
    await (controller as any).startTurn({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      binding: (controller as any).store.getBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      }),
      workspaceDir: "/repo/openclaw",
      prompt: "Continue the chipcdx production task",
      reason: "command",
    });

    await controller.stop();
    await flushAsyncWork();

    const binding = (controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });
    expect(binding?.taskState?.stage).toBe("executing");
    const sentTexts = harness.sendMessageTelegram.mock.calls.flatMap((call) => {
      const [, text] = call as unknown as [unknown, unknown];
      return typeof text === "string" ? [text] : [];
    });
    expect(sentTexts).not.toContain("Codex stopped.");
  });
});
