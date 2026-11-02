import type { Metadata } from "next";
import { fieldsFor } from "../fields";
import { SettingsForm } from "../settings-form";
import { PasswordCard } from "../account-password";
import { PageHead } from "../ui";

export const metadata: Metadata = { title: "Account · Settings" };

export default async function AccountSettings() {
  const fields = await fieldsFor("account", "signin");
  // Single sign-on gets its own heading under the password.
  const withSso = fields.map((f) => (f.group === "signin" && !f.advanced ? { ...f, section: "Single sign-on" } : f));
  return (
    <>
      <PageHead title="Account">Who you are, your working day, and how you sign in.</PageHead>
      <SettingsForm
        fields={withSso}
        slots={{
          "Single sign-on": {
            before: <PasswordCard fromEnv={!!process.env.DEBRIEF_PASSWORD} />,
            note: "Sign in through Authentik or another OpenID Connect provider. The password keeps working as a fallback.",
          },
        }}
      />
    </>
  );
}
