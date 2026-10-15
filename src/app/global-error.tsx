"use client";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui", padding: 40 }}>
        <h1>Something went wrong</h1>
        <p>The application hit an unexpected error. Nothing has been changed by this error page.</p>
        {error.digest ? <p>Reference: {error.digest}</p> : null}
        <button onClick={() => reset()}>Try again</button>
      </body>
    </html>
  );
}
