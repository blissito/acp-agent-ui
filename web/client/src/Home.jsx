import React, { useState } from "react";
import { useNavigate } from "react-router";

// Home: botón para crear una conversación en el backend y saltar a /c/:id.
export default function Home() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function create() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/conversations", { method: "POST" });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      navigate(`/c/${d.conversationId}`);
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <h1>Gansito</h1>
      <p className="sub">Agente en caja EasyBits. El agente corre en su microVM; aquí solo lo manejas.</p>
      <button onClick={create} disabled={busy}>
        {busy ? "Creando…" : "Nueva conversación"}
      </button>
      {err && <p className="err">Error: {err}</p>}
    </div>
  );
}
