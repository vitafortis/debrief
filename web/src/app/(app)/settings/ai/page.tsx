import type { Metadata } from "next";
import { publicUrl } from "@debrief/core";
import { fieldsFor } from "../fields";
import { SectionLabel, SettingsForm } from "../settings-form";
import { CopyField, TestAi } from "./test-ai";
import { PageHead } from "../ui";

export const metadata: Metadata = { title: "AI summaries · Settings" };

export default async function AiSettings() {
  const fields = await fieldsFor("ai");
  const mcp = `${publicUrl() || "http://<server>:3001"}/mcp`;
  return (
    <>
      <PageHead title="AI summaries">
        Once a recording is transcribed, a model writes its summary and pulls out the action items. Bring a key from whichever provider you use, or run your own model.
      </PageHead>
      <SettingsForm
        fields={fields}
        slots={{
          Connection: { footer: <TestAi /> },
          Summaries: {
            after: (
              <div className="space-y-2 pt-4">
                <SectionLabel
                  name="Or use your assistant"
                  note="Debrief has an MCP server, so Claude, ChatGPT or any MCP client can search your recordings and file tasks itself, with no key here."
                />
                <section className="card grid gap-2 px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,17rem)] md:items-center md:gap-6">
                  <div>
                    <p className="text-[0.8125rem] font-medium">MCP address</p>
                    <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">Use a key from Recorder &amp; devices as the bearer token.</p>
                  </div>
                  <CopyField value={mcp} />
                </section>
              </div>
            ),
          },
        }}
      />
    </>
  );
}
