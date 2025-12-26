import * as vscode from "vscode";

export interface TargetSpec {
  description?: string;
  command?: string;
  args?: Array<string | number | boolean>;
  env?: Record<string, string>;
  hint?: string;
  timeout?: number;
  always_allow?: string[];
  type?: string;
}

export interface RegistryServer {
  name: string;
  categories?: string[];
  common?: TargetSpec;
  targets?: Record<string, TargetSpec>;
}

export interface RegistryDocument {
  version?: number;
  servers?: Array<RegistryServer>;
}

export interface HubSettings {
  hubUrl: string;
  httpBaseUrl?: string;
  profile: string;
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
}

export interface HubHealthResponse {
  status?: string;
  timestamp?: string;
  sessions?: number;
}

export interface HubReadyResponse {
  ready?: boolean;
  servers?: number;
  error?: string;
}

export interface HubServerInfo {
  name: string;
  description?: string;
  categories?: string[];
}

export interface DaemonServerInfo {
  name: string;
  categories?: string[];
  description?: string;
  running: boolean;
}

export interface DaemonToolInfo {
  name: string;
  description?: string;
  server: string;
}

export interface HubStatusSnapshot {
  health?: HubHealthResponse;
  readiness?: HubReadyResponse;
  servers: HubServerInfo[];
  lastUpdated?: Date;
  error?: string;
}

export interface VscodeConfigSnapshot {
  source: string;
  serverNames: string[];
  hubRouted: string[];
  localRouted: string[];
}

export interface ConfigSyncState {
  status: "synced" | "out-of-sync" | "unknown" | "no-generated";
  generatedPath?: string;
  appliedPath?: string;
  generatedHash?: string;
  appliedHash?: string;
  lastChecked: Date;
  diffs?: string[];
}

export interface ActionableError {
  message: string;
  actions: { label: string; command?: string; url?: string }[];
}
