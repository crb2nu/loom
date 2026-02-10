import * as vscode from "vscode";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  constructor(
    private channel: vscode.OutputChannel,
    private prefix: string = "",
    private level: LogLevel = "info"
  ) {}

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  child(prefix: string): Logger {
    const combined = this.prefix ? `${this.prefix}:${prefix}` : prefix;
    return new Logger(this.channel, combined, this.level);
  }

  debug(message: string): void {
    this.log("debug", message);
  }

  info(message: string): void {
    this.log("info", message);
  }

  warn(message: string): void {
    this.log("warn", message);
  }

  error(message: string): void {
    this.log("error", message);
  }

  private log(level: LogLevel, message: string): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) {
      return;
    }
    const timestamp = new Date().toISOString();
    const tag = this.prefix ? ` [${this.prefix}]` : "";
    this.channel.appendLine(`[${timestamp}]${tag} ${level.toUpperCase()}: ${message}`);
  }
}
