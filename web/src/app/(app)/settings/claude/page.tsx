import type { Metadata } from "next";
import { publicUrl } from "@debrief/core";
import { fieldsFor } from "../fields";
import { SettingsForm } from "../settings-form";

export const metadata: Metadata = { title: "Claude · Settings" };

export default async function ClaudeSettings() {
  const fields = await fieldsFor("claude");
  const mcp = `${publicUrl() || "http://<server>:3001"}/mcp`;
  return (
    <>
      <SettingsForm title="Claude" description="Summaries and action items in the app, and the MCP server Claude connects to." fields={fields} />
      <section className="card px-4 py-3 text-xs text-muted-foreground">
        Connect Claude to <code className="font-mono text-foreground">{mcp}</code> with an API key from Devices &amp; keys as the bearer token.
      </section>
    </>
  );
}
