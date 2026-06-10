/**
 * Optional LLM narration of the council's structured outputs.
 *
 * The LLM receives the deterministic payload an agent produced and turns it
 * into one plain-English sentence for the dashboard. It cannot change any
 * number: the narration is display-only, and the structured payload it
 * narrates is what gets hashed and recorded on-chain.
 *
 * Enabled only when ANTHROPIC_API_KEY is set; otherwise the council uses its
 * deterministic template notes.
 */

import type { AgentMessage } from "./types.js";

const MODEL = "claude-haiku-4-5-20251001";

export function createNarrator(
  apiKey: string | undefined,
): ((agent: AgentMessage["agent"], payload: unknown) => Promise<string | null>) | undefined {
  if (!apiKey) return undefined;

  return async (agent, payload) => {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 150,
          system:
            "You narrate one step of an automated treasury review for a dashboard. " +
            "Write ONE short plain-English sentence summarizing the structured output you are given. " +
            "Quote numbers exactly as they appear; never compute, round differently, or invent any number.",
          messages: [
            {
              role: "user",
              content: `Agent "${agent}" produced this structured output:\n${JSON.stringify(payload)}`,
            },
          ],
        }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { content: { type: string; text?: string }[] };
      const text = data.content.find((c) => c.type === "text")?.text?.trim();
      return text || null;
    } catch {
      return null;
    }
  };
}
