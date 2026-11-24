import { auditCommand } from "./commands/audit.js";
import { explainCommand, findingsCommand } from "./commands/read.js";
import { toolVersion } from "./paths.js";

export interface Command {
  name: string;
  summary: string;
  usage: string;
  run(argv: string[]): Promise<number>;
}

export const commands: Command[] = [auditCommand, findingsCommand, explainCommand];

function helpText(): string {
  const width = Math.max(...commands.map((c) => c.name.length), 8);
  const lines = commands.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`);
  return [
    `ci-ledger ${toolVersion()}`,
    "Explains a GitHub Actions bill, merge queue and PR flow, and ranks fixes by minutes saved.",
    "",
    "Usage: ci-ledger <command> [options]",
    "",
    "Commands:",
    ...(lines.length ? lines : ["  (none yet)"]),
    "",
    "Run `ci-ledger <command> --help` for a command's options.",
  ].join("\n");
}

export async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "help" || name === "--help" || name === "-h") {
    const target = name === "help" ? commands.find((c) => c.name === rest[0]) : undefined;
    console.log(target ? target.usage : helpText());
    return 0;
  }
  if (name === "--version" || name === "-v" || name === "version") {
    console.log(toolVersion());
    return 0;
  }
  const command = commands.find((c) => c.name === name);
  if (!command) {
    console.error(`Unknown command "${name}".\n\n${helpText()}`);
    return 2;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(command.usage);
    return 0;
  }
  try {
    return await command.run(rest);
  } catch (err) {
    console.error(`ci-ledger ${name}: ${err instanceof Error ? err.message : String(err)}`);
    if (process.env.CI_LEDGER_DEBUG && err instanceof Error) console.error(err.stack);
    return 1;
  }
}
