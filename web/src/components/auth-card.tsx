import { Logo } from "@/components/logo";

/** The centred card for signing in and first-run setup. */
export function AuthCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="relative grid min-h-dvh place-items-center overflow-hidden px-4">
      <div className="dot-grid mask-fade pointer-events-none absolute inset-0 opacity-70" />
      <div className="glow-top pointer-events-none absolute inset-x-0 top-0 h-[480px]" />
      <div className="card relative w-full max-w-sm p-7 shadow-surface-lg">
        <div className="mb-6 flex flex-col items-center text-center">
          <Logo size={44} />
          <h1 className="mt-4 text-lg font-semibold tracking-tight">Debrief</h1>
          <p className="mt-1 text-[0.8125rem] text-muted-foreground">{title}</p>
        </div>
        {children}
      </div>
    </div>
  );
}
