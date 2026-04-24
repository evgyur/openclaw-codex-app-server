import { COMMAND_SUMMARY, type CommandName } from "./commands.js";

type CommandHelpFlag = {
  flag: string;
  description: string;
};

type CommandHelpEntry = {
  summary: string;
  usage: string;
  flags?: CommandHelpFlag[];
  examples: string[];
  notes?: string;
};

export const COMMAND_HELP: Record<CommandName, CommandHelpEntry> = {
  cas_resume: {
    summary: COMMAND_SUMMARY.cas_resume,
    usage: "/cas_resume [--projects|-p] [--new [project]] [--all|-a] [--cwd <path>] [--sync] [--model <name>] [--fast|--no-fast] [--yolo|--no-yolo] [filter]",
    flags: [
      { flag: "--projects, --project, -p", description: "Browse projects first, then pick a thread." },
      { flag: "--new [project]", description: "Start a new thread; optionally pass a project filter or workspace path." },
      { flag: "--all, -a", description: "Search recent threads across projects." },
      { flag: "--cwd <path>", description: "Restrict search to one workspace path." },
      { flag: "--sync", description: "Sync the chat/topic name to the selected thread title." },
      { flag: "--model <name>", description: "Save a preferred model on the binding and apply it when possible." },
      { flag: "--fast, --no-fast", description: "Enable or disable fast mode while binding or creating a thread." },
      { flag: "--yolo, --no-yolo", description: "Switch between Default and Full Access permissions while binding." },
      { flag: "[filter]", description: "Match by thread title, id, or project text." },
    ],
    examples: [
      "/cas_resume",
      "/cas_resume --projects",
      "/cas_resume --new openclaw",
      "/cas_resume thread-1 --model openai/gpt-5.4 --fast --yolo",
      "/cas_resume --cwd ~/github/openclaw release-fix",
      "/cas_resume --sync thread-1",
    ],
    notes: "Use --new with no filter to start immediately in the resolved workspace for this conversation, or add --projects / --cwd when you want to choose explicitly. Full Access depends on the current Codex Desktop profiles.",
  },
  cas_new: {
    summary: COMMAND_SUMMARY.cas_new,
    usage: "/cas_new [same overrides as /cas_resume]",
    examples: ["/cas_new", "/cas_new --model openai/gpt-5.4"],
    notes: "Fast alias for `/cas_resume --new --yolo --model openai-codex/gpt-5.5 --fast`, and it also saves reasoning=high for the new binding. Use `/cas_new` when you want a fresh Codex thread immediately in the resolved workspace with Full Access.",
  },
  cas_detach: {
    summary: COMMAND_SUMMARY.cas_detach,
    usage: "/cas_detach",
    examples: ["/cas_detach"],
  },
  cas_status: {
    summary: COMMAND_SUMMARY.cas_status,
    usage: "/cas_status [--model <name>] [--fast|--no-fast] [--yolo|--no-yolo]",
    flags: [
      { flag: "--model <name>", description: "Update the preferred model for the current binding." },
      { flag: "--fast, --no-fast", description: "Enable or disable fast mode for the current binding." },
      { flag: "--yolo, --no-yolo", description: "Switch between Default and Full Access permissions." },
    ],
    examples: [
      "/cas_status",
      "/cas_status --model openai/gpt-5.4",
      "/cas_status --fast --yolo",
    ],
    notes: "With no flags, this shows the current status card and interactive controls.",
  },
  cas_task: {
    summary: COMMAND_SUMMARY.cas_task,
    usage: "/cas_task [show|clear|goal <text>|stage <stage>|next <text>|evidence <text>|blocker <text>|clear-blocker]",
    flags: [
      { flag: "show", description: "Show the current cockpit task card summary for this binding." },
      { flag: "clear", description: "Clear the entire cockpit task card for this binding." },
      { flag: "goal <text>", description: "Set the task goal." },
      { flag: "stage <stage>", description: "Set the current stage (intake, clarifying, planned, executing, verifying, done, blocked)." },
      { flag: "next <text>", description: "Set the next exact operator or agent action." },
      { flag: "evidence <text>", description: "Set the latest evidence summary." },
      { flag: "blocker <text>", description: "Set the current blocker summary." },
      { flag: "clear-blocker", description: "Clear the current blocker." },
    ],
    examples: [
      "/cas_task show",
      "/cas_task goal Ship the prod-safe cockpit task card",
      "/cas_task stage executing",
      "/cas_task next Run the prod smoke checks",
      "/cas_task evidence Local vitest is green",
      "/cas_task blocker Waiting for Telegram callback confirmation",
    ],
    notes: "This command updates structured task metadata without changing the bound Codex thread itself.",
  },
  cas_verify: {
    summary: COMMAND_SUMMARY.cas_verify,
    usage: "/cas_verify [show|clear|unverified|partial|verified|risk] [summary] [--risk <text>]",
    flags: [
      { flag: "show", description: "Show the current verification state." },
      { flag: "clear", description: "Remove verification metadata from the task card." },
      { flag: "unverified|partial|verified|risk", description: "Set the verification status. Use `risk` for verified-with-risk." },
      { flag: "[summary]", description: "Optional verification summary or evidence note." },
      { flag: "--risk <text>", description: "Residual risk text when using `risk`." },
    ],
    examples: [
      "/cas_verify show",
      "/cas_verify partial Local tests passed; prod smoke pending",
      "/cas_verify verified Local tests and host-side typecheck passed",
      "/cas_verify risk Smoke passed --risk Telegram callback drift after deploy",
    ],
    notes: "When a verified task receives file edits in a new run, the plugin should downgrade it to stale automatically.",
  },
  cas_checkpoint: {
    summary: COMMAND_SUMMARY.cas_checkpoint,
    usage: "/cas_checkpoint [show|clear|save <summary>] [--next <text>]",
    flags: [
      { flag: "show", description: "Show the current resumable checkpoint." },
      { flag: "clear", description: "Remove the current checkpoint." },
      { flag: "save <summary>", description: "Save a resumable checkpoint summary." },
      { flag: "--next <text>", description: "Attach the next exact resume action to the checkpoint." },
    ],
    examples: [
      "/cas_checkpoint show",
      "/cas_checkpoint save Runtime artifact is ready --next Copy to ~/.openclaw/extensions and run /cas_status",
      "/cas_checkpoint clear",
    ],
    notes: "Use checkpoints to preserve resume context for the bound topic/thread without creating a second control plane.",
  },
  cas_stop: {
    summary: COMMAND_SUMMARY.cas_stop,
    usage: "/cas_stop",
    examples: ["/cas_stop"],
  },
  cas_steer: {
    summary: COMMAND_SUMMARY.cas_steer,
    usage: "/cas_steer <message>",
    flags: [{ flag: "<message>", description: "Follow-up steer text for the active run." }],
    examples: [
      "/cas_steer focus on the failing tests first",
      "/cas_steer explain why this migration is safe",
    ],
  },
  cas_plan: {
    summary: COMMAND_SUMMARY.cas_plan,
    usage: "/cas_plan <goal> | /cas_plan off",
    flags: [
      { flag: "<goal>", description: "Ask Codex to plan the work instead of executing it." },
      { flag: "off", description: "Exit plan mode for this conversation." },
    ],
    examples: [
      "/cas_plan design a rollback-safe migration strategy",
      "/cas_plan off",
    ],
  },
  cas_review: {
    summary: COMMAND_SUMMARY.cas_review,
    usage: "/cas_review [focus]",
    flags: [{ flag: "[focus]", description: "Optional review focus; defaults to uncommitted changes." }],
    examples: [
      "/cas_review",
      "/cas_review focus on auth and permission regressions",
    ],
  },
  cas_compact: {
    summary: COMMAND_SUMMARY.cas_compact,
    usage: "/cas_compact",
    examples: ["/cas_compact"],
  },
  cas_skills: {
    summary: COMMAND_SUMMARY.cas_skills,
    usage: "/cas_skills [filter]",
    flags: [{ flag: "[filter]", description: "Optional text filter for skill name/description/path." }],
    examples: [
      "/cas_skills",
      "/cas_skills release",
    ],
    notes: "When a conversation is bound, the reply can include picker buttons and you can also run a skill directly by typing $skill-name.",
  },
  cas_experimental: {
    summary: COMMAND_SUMMARY.cas_experimental,
    usage: "/cas_experimental",
    examples: ["/cas_experimental"],
  },
  cas_mcp: {
    summary: COMMAND_SUMMARY.cas_mcp,
    usage: "/cas_mcp [filter]",
    flags: [{ flag: "[filter]", description: "Optional text filter for server id, status, or transport." }],
    examples: [
      "/cas_mcp",
      "/cas_mcp github",
    ],
  },
  cas_fast: {
    summary: COMMAND_SUMMARY.cas_fast,
    usage: "/cas_fast [on|off|status]",
    flags: [
      { flag: "on", description: "Enable fast mode for the bound thread." },
      { flag: "off", description: "Disable fast mode for the bound thread." },
      { flag: "status", description: "Show the current fast mode state." },
    ],
    examples: [
      "/cas_fast",
      "/cas_fast on",
      "/cas_fast status",
    ],
    notes: "With no argument, this command toggles fast mode. /cas_status also exposes fast mode controls.",
  },
  cas_model: {
    summary: COMMAND_SUMMARY.cas_model,
    usage: "/cas_model [model_name]",
    flags: [{ flag: "[model_name]", description: "Optional model id to set; omit to list models or show a picker on bound conversations." }],
    examples: [
      "/cas_model",
      "/cas_model openai/gpt-5.4",
    ],
    notes: "The status card is the main interactive model-control surface, but this command remains available.",
  },
  cas_permissions: {
    summary: COMMAND_SUMMARY.cas_permissions,
    usage: "/cas_permissions",
    examples: ["/cas_permissions"],
    notes: "This shows account and permission status. To change permissions, use /cas_status --yolo or the status card toggle.",
  },
  cas_init: {
    summary: COMMAND_SUMMARY.cas_init,
    usage: "/cas_init [args]",
    flags: [{ flag: "[args]", description: "Arguments forwarded directly to Codex /init." }],
    examples: [
      "/cas_init",
      "/cas_init --help",
    ],
  },
  cas_diff: {
    summary: COMMAND_SUMMARY.cas_diff,
    usage: "/cas_diff [args]",
    flags: [{ flag: "[args]", description: "Arguments forwarded directly to Codex /diff." }],
    examples: [
      "/cas_diff",
      "/cas_diff HEAD~1..HEAD",
    ],
  },
  cas_rename: {
    summary: COMMAND_SUMMARY.cas_rename,
    usage: "/cas_rename [--sync] <new name>",
    flags: [
      { flag: "--sync", description: "Also sync the chat/topic name when supported." },
      { flag: "<new name>", description: "New thread name. If omitted, shows style buttons." },
    ],
    examples: [
      "/cas_rename approval flow cleanup",
      "/cas_rename --sync approval flow cleanup",
      "/cas_rename --sync",
    ],
    notes: "If you omit the name, the plugin offers derived naming styles from the current thread metadata.",
  },
};

export function formatCommandUsage(commandName: CommandName): string {
  return `Usage: ${COMMAND_HELP[commandName].usage}`;
}

export function renderCommandHelpText(commandName: string): string {
  const entry = COMMAND_HELP[commandName as CommandName];
  if (!entry) {
    return "Help is unavailable for this command.";
  }
  const lines: string[] = [
    `/${commandName}`,
    entry.summary,
    "",
    "Usage:",
    entry.usage,
  ];
  if (entry.flags?.length) {
    lines.push("", "Flags/Args:");
    for (const item of entry.flags) {
      lines.push(`- ${item.flag}: ${item.description}`);
    }
  }
  lines.push("", "Examples:");
  for (const example of entry.examples) {
    lines.push(`- ${example}`);
  }
  if (entry.notes) {
    lines.push("", "Notes:", entry.notes);
  }
  return lines.join("\n");
}
