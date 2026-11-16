import { signIn } from "@/auth";

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <div className="panel" style={{ maxWidth: 440, margin: "60px auto", textAlign: "center" }}>
      <h1>Sign in</h1>
      <p className="muted">Use your Sahajta Google account. This also lets the launcher read the Drive folders you pick (read only).</p>
      {error && (
        <div className="msg error">
          {error === "AccessDenied" ? "This Google account is not on the list of people who can use the launcher. Ask your admin to add it." : "Sign-in didn't work. Try again."}
        </div>
      )}
      <form
        action={async () => {
          "use server";
          await signIn("google", { redirectTo: "/" });
        }}
      >
        <button className="primary big" type="submit" style={{ marginTop: 12 }}>
          Sign in with Google
        </button>
      </form>
    </div>
  );
}
