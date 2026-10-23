import type { Metadata } from "next";
import { fieldsFor } from "../fields";
import { SettingsForm } from "../settings-form";
import { PasswordCard } from "./password-card";

export const metadata: Metadata = { title: "Sign-in · Settings" };

export default async function SignInSettings() {
  const fields = await fieldsFor("signin");
  return (
    <>
      <PasswordCard fromEnv={!!process.env.DEBRIEF_PASSWORD} />
      <SettingsForm
        title="Single sign-on"
        description="Sign in through Authentik or another OpenID Connect provider. The password keeps working as a fallback."
        fields={fields}
      />
    </>
  );
}
