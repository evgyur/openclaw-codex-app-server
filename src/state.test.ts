import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PluginStateStore, buildPluginSessionKey } from "./state.js";

async function makeStoreDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "oc-codex-plugin-"));
}

async function makeStore(dir?: string): Promise<PluginStateStore> {
  const resolvedDir = dir ?? (await makeStoreDir());
  const store = new PluginStateStore(resolvedDir);
  await store.load();
  return store;
}

describe("state store", () => {
  it("persists bindings and callbacks", async () => {
    const dir = await makeStoreDir();
    const store = await makeStore(dir);
    await store.upsertPendingBind({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "124",
      },
      threadId: "thread-pending",
      workspaceDir: "/tmp/pending",
      threadTitle: "Pending thread",
      updatedAt: Date.now(),
    });
    await store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: buildPluginSessionKey("thread-1"),
      threadId: "thread-1",
      workspaceDir: "/tmp/work",
      contextUsage: {
        totalTokens: 9_800,
        contextWindow: 258_000,
        remainingPercent: 96,
      },
      updatedAt: Date.now(),
    });
    const callback = await store.putCallback({
      kind: "resume-thread",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      threadId: "thread-1",
      workspaceDir: "/tmp/work",
      syncTopic: true,
    });
    const startThreadCallback = await store.putCallback({
      kind: "start-new-thread",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      workspaceDir: "/tmp/new-work",
      syncTopic: true,
    });
    const promptCallback = await store.putCallback({
      kind: "run-prompt",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      prompt: "Implement the plan.",
      workspaceDir: "/tmp/work",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "openai/gpt-5.4",
          developerInstructions: null,
        },
      },
    });
    const modelCallback = await store.putCallback({
      kind: "set-model",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      model: "gpt-5.2-codex",
    });
    const replyCallback = await store.putCallback({
      kind: "reply-text",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      text: "Okay. Staying in plan mode.",
    });
    const reloaded = await makeStore(dir);

    expect(reloaded.listBindings()).toHaveLength(1);
    expect(reloaded.listBindings()[0]?.contextUsage?.totalTokens).toBe(9_800);
    expect(reloaded.getPendingBind({
      channel: "telegram",
      accountId: "default",
      conversationId: "124",
    })?.threadId).toBe("thread-pending");
    expect(reloaded.getCallback(callback.token)?.kind).toBe("resume-thread");
    expect(reloaded.getCallback(startThreadCallback.token)?.kind).toBe("start-new-thread");
    const resumeCallback = reloaded.getCallback(callback.token);
    expect(resumeCallback?.kind).toBe("resume-thread");
    expect(resumeCallback && resumeCallback.kind === "resume-thread" ? resumeCallback.syncTopic : undefined).toBe(true);
    const newThreadCallback = reloaded.getCallback(startThreadCallback.token);
    expect(newThreadCallback?.kind).toBe("start-new-thread");
    expect(
      newThreadCallback && newThreadCallback.kind === "start-new-thread"
        ? newThreadCallback.workspaceDir
        : undefined,
    ).toBe("/tmp/new-work");
    expect(reloaded.getCallback(promptCallback.token)?.kind).toBe("run-prompt");
    const runPrompt = reloaded.getCallback(promptCallback.token);
    expect(runPrompt && runPrompt.kind === "run-prompt" ? runPrompt.collaborationMode : undefined).toEqual({
      mode: "default",
      settings: {
        model: "openai/gpt-5.4",
        developerInstructions: null,
      },
    });
    expect(reloaded.getCallback(modelCallback.token)?.kind).toBe("set-model");
    expect(reloaded.getCallback(replyCallback.token)?.kind).toBe("reply-text");
  });

  it("replaces duplicate callbacks and prunes expired entries on put", async () => {
    const dir = await makeStoreDir();
    const store = await makeStore(dir);
    const conversation = {
      channel: "telegram" as const,
      accountId: "default",
      conversationId: "123",
    };

    const expired = await store.putCallback({
      kind: "show-model-picker",
      conversation,
      ttlMs: -1,
    });
    const first = await store.putCallback({
      kind: "refresh-status",
      conversation,
    });
    const second = await store.putCallback({
      kind: "refresh-status",
      conversation,
    });
    const reloaded = await makeStore(dir);
    const snapshot = JSON.parse(await fs.readFile(reloaded.filePath, "utf8")) as {
      callbacks: Array<{ token: string; kind: string }>;
    };

    expect(reloaded.getCallback(expired.token)).toBeNull();
    expect(second.token).toBe(first.token);
    expect(reloaded.getCallback(first.token)?.kind).toBe("refresh-status");
    expect(snapshot.callbacks).toHaveLength(1);
    expect(snapshot.callbacks[0]?.token).toBe(first.token);
  });

  it("removes pending requests and related callbacks", async () => {
    const store = await makeStore();
    await store.upsertPendingRequest({
      requestId: "req-1",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "chan-1",
      },
      threadId: "thread-1",
      workspaceDir: "/tmp/work",
      state: {
        requestId: "req-1",
        options: ["yes"],
        expiresAt: Date.now() + 10_000,
      },
      updatedAt: Date.now(),
    });
    const callback = await store.putCallback({
      kind: "pending-input",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "chan-1",
      },
      requestId: "req-1",
      actionIndex: 0,
    });
    const questionnaireCallback = await store.putCallback({
      kind: "pending-questionnaire",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "chan-1",
      },
      requestId: "req-1",
      questionIndex: 0,
      action: "select",
      optionIndex: 0,
    });
    await store.removePendingRequest("req-1");
    expect(store.getPendingRequestById("req-1")).toBeNull();
    expect(store.getCallback(callback.token)).toBeNull();
    expect(store.getCallback(questionnaireCallback.token)).toBeNull();
  });

  it("clears a pending bind when the binding is finalized", async () => {
    const store = await makeStore();
    await store.upsertPendingBind({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "user:1",
      },
      threadId: "thread-1",
      workspaceDir: "/tmp/work",
      updatedAt: Date.now(),
    });

    await store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "user:1",
      },
      sessionKey: buildPluginSessionKey("thread-1"),
      threadId: "thread-1",
      workspaceDir: "/tmp/work",
      updatedAt: Date.now(),
    });

    expect(
      store.getPendingBind({
        channel: "discord",
        accountId: "default",
        conversationId: "user:1",
      }),
    ).toBeNull();
  });

  it("clears a pending bind when the conversation is explicitly removed", async () => {
    const store = await makeStore();
    await store.upsertPendingBind({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      threadId: "thread-1",
      workspaceDir: "/tmp/work",
      updatedAt: Date.now(),
    });

    await store.removeBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });

    expect(
      store.getPendingBind({
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      }),
    ).toBeNull();
  });

  it("persists conversation preferences in bindings across reload", async () => {
    const dir = await makeStoreDir();
    const store = await makeStore(dir);
    const updatedAt = Date.now();
    await store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      sessionKey: buildPluginSessionKey("thread-1"),
      threadId: "thread-1",
      workspaceDir: "/tmp/work",
      permissionsMode: "full-access",
      preferences: {
        preferredModel: "openai/gpt-5.3",
        preferredServiceTier: "fast",
        updatedAt,
      },
      updatedAt,
    });

    const reloaded = await makeStore(dir);
    const binding = reloaded.getBinding({
      channel: "discord",
      accountId: "default",
      conversationId: "channel:chan-1",
    });

    expect(binding?.preferences).toEqual({
      preferredModel: "openai/gpt-5.3",
      preferredServiceTier: "fast",
      updatedAt,
    });
    expect(binding?.permissionsMode).toBe("full-access");
  });

  it("persists cockpit task state in bindings across reload", async () => {
    const dir = await makeStoreDir();
    const store = await makeStore(dir);
    const updatedAt = Date.now();
    await store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: buildPluginSessionKey("thread-1"),
      threadId: "thread-1",
      workspaceDir: "/tmp/work",
      taskState: {
        goal: "Roll out the cockpit task card",
        stage: "executing",
        nextAction: "Deploy the tested plugin build",
        latestEvidence: "Local vitest run is green",
        blocker: "Waiting for maintenance window",
        lastHeartbeatAt: updatedAt - 60_000,
        verification: {
          status: "partial",
          summary: "Local tests passed; prod smoke still pending",
          updatedAt,
        },
        checkpoint: {
          summary: "Canonical repo updated and ready to sync",
          nextAction: "Backup runtime artifact and copy the new build",
          savedAt: updatedAt,
        },
        updatedAt,
      },
      updatedAt,
    });

    const reloaded = await makeStore(dir);
    const binding = reloaded.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });

    expect(binding?.taskState).toEqual({
      goal: "Roll out the cockpit task card",
      stage: "executing",
      nextAction: "Deploy the tested plugin build",
      latestEvidence: "Local vitest run is green",
      blocker: "Waiting for maintenance window",
      lastHeartbeatAt: updatedAt - 60_000,
      verification: {
        status: "partial",
        summary: "Local tests passed; prod smoke still pending",
        updatedAt,
      },
      checkpoint: {
        summary: "Canonical repo updated and ready to sync",
        nextAction: "Backup runtime artifact and copy the new build",
        savedAt: updatedAt,
      },
      updatedAt,
    });
  });

  it("migrates legacy profile and permission fields into permissions mode", async () => {
    const dir = await makeStoreDir();
    const stateDir = path.join(dir, "openclaw-codex-app-server");
    const bindingUpdatedAt = Date.now();
    const pendingBindUpdatedAt = bindingUpdatedAt + 1;
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "state.json"),
      `${JSON.stringify({
        version: 1,
        bindings: [
          {
            conversation: {
              channel: "discord",
              accountId: "default",
              conversationId: "channel:chan-1",
            },
            sessionKey: buildPluginSessionKey("thread-1"),
            threadId: "thread-1",
            workspaceDir: "/tmp/work",
            appServerProfile: "default",
            pendingAppServerProfile: "full-access",
            preferences: {
              preferredModel: "openai/gpt-5.3",
              preferredReasoningEffort: "high",
              preferredServiceTier: "fast",
              preferredApprovalPolicy: "never",
              preferredSandbox: "danger-full-access",
              updatedAt: bindingUpdatedAt,
            },
            updatedAt: bindingUpdatedAt,
          },
        ],
        pendingBinds: [
          {
            conversation: {
              channel: "telegram",
              accountId: "default",
              conversationId: "123",
            },
            threadId: "thread-2",
            workspaceDir: "/tmp/pending",
            appServerProfile: "full-access",
            preferences: {
              preferredModel: "openai/gpt-5.4",
              preferredServiceTier: "default",
              preferredApprovalPolicy: "never",
              preferredSandbox: "danger-full-access",
              updatedAt: pendingBindUpdatedAt,
            },
            updatedAt: pendingBindUpdatedAt,
          },
        ],
        pendingRequests: [],
        callbacks: [],
      }, null, 2)}\n`,
      "utf8",
    );

    const reloaded = await makeStore(dir);
    const binding = reloaded.getBinding({
      channel: "discord",
      accountId: "default",
      conversationId: "channel:chan-1",
    });
    const pendingBind = reloaded.getPendingBind({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });

    expect(binding?.permissionsMode).toBe("default");
    expect(binding?.pendingPermissionsMode).toBe("full-access");
    expect(binding?.preferences).toEqual({
      preferredModel: "openai/gpt-5.3",
      preferredReasoningEffort: "high",
      preferredServiceTier: "fast",
      updatedAt: bindingUpdatedAt,
    });
    expect(pendingBind?.permissionsMode).toBe("full-access");
    expect(pendingBind?.preferences).toEqual({
      preferredModel: "openai/gpt-5.4",
      preferredServiceTier: "default",
      updatedAt: pendingBindUpdatedAt,
    });
  });
});
