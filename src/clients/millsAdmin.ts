import * as vscode from "vscode";

import { postJson } from "../utils/http";

import { MillsBacklogItem, MillsCouncilRun, MillsSettings } from "./mills";
import {
  MILLS_REST_MUTATIONS,
  millsPipelineEscalatePath,
  millsPipelinePausePath,
  millsPipelineResumePath,
  millsPolicyProposalApplyPath,
  millsPolicyProposalRejectPath,
} from "./millsTransport";

/**
 * Settings for the admin (mutation) client. Bearer token comes from
 * SecretStorage (never settings) and the HUD URL is shared with the
 * read-only client.
 */
export interface MillsAdminSettings extends MillsSettings {
  adminToken: string;
}

export interface BacklogSubmitInput {
  ID: string;
  Title: string;
  Priority?: string;
  Labels?: string[];
}

/**
 * Mutation client for `/api/mills/*` POST endpoints. Every call requires
 * a bearer token; the HUD enforces both its own admin gate and the
 * operator's gate behind the proxy. The token never leaves SecretStorage
 * outside of this client.
 */
export class MillsAdminClient {
  private readonly settings: MillsAdminSettings;
  private readonly channel: vscode.OutputChannel;

  constructor(settings: MillsAdminSettings, channel: vscode.OutputChannel) {
    this.settings = settings;
    this.channel = channel;
  }

  // ----- Council -----

  async councilDryrun(): Promise<MillsCouncilRun> {
    return this.post<MillsCouncilRun>(MILLS_REST_MUTATIONS.councilDryrun);
  }

  async councilRun(): Promise<MillsCouncilRun> {
    return this.post<MillsCouncilRun>(MILLS_REST_MUTATIONS.councilRun);
  }

  // ----- Pipeline -----

  async pipelinePause(id: string): Promise<unknown> {
    return this.post<unknown>(millsPipelinePausePath(id));
  }

  async pipelineResume(id: string): Promise<unknown> {
    return this.post<unknown>(millsPipelineResumePath(id));
  }

  async pipelineEscalate(id: string): Promise<unknown> {
    return this.post<unknown>(millsPipelineEscalatePath(id));
  }

  // ----- Policy proposals -----

  async proposalApply(id: string): Promise<unknown> {
    return this.post<unknown>(millsPolicyProposalApplyPath(id));
  }

  async proposalReject(id: string): Promise<unknown> {
    return this.post<unknown>(millsPolicyProposalRejectPath(id));
  }

  // ----- Backlog -----

  async backlogSubmit(input: BacklogSubmitInput): Promise<MillsBacklogItem> {
    return this.post<MillsBacklogItem>(MILLS_REST_MUTATIONS.backlogCreate, input);
  }

  // ----- Internals -----

  private async post<T>(pathName: string, body?: unknown): Promise<T> {
    if (!this.settings.hudBaseUrl) {
      throw new Error("Mills HUD URL is not configured");
    }
    if (!this.settings.adminToken) {
      throw new Error("Mills admin token is not set");
    }
    const target = new URL(pathName, this.settings.hudBaseUrl);
    try {
      return await postJson<T>(target.toString(), body, this.buildHeaders());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.channel.appendLine(`[MillsAdmin] POST ${pathName} failed: ${message}`);
      throw error;
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.settings.adminToken}`,
    };
    if (this.settings.cfAccessClientId && this.settings.cfAccessClientSecret) {
      headers["CF-Access-Client-Id"] = this.settings.cfAccessClientId;
      headers["CF-Access-Client-Secret"] = this.settings.cfAccessClientSecret;
    }
    return headers;
  }
}
