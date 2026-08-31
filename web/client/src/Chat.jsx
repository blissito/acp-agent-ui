import React, { useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router";
import { Streamdown } from "streamdown";

// Chat: conversación viva en /c/:id. EventSource al backend, chunks en vivo.
export default function Chat() {
  const { id } = useParams();

  const [messages, setMessages] = useState([]);
  const [status, setStatus] = useState("conectando"); // conectando | conectado | pensando | listo | error | cerrado
  const [usage, setUsage] = useState(null);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false); // hay un mensaje del bot en curso
  const idRef = useRef(0);
  const currentBot = useRef(null); // id del mensaje bot en curso
  const msgsRef = useRef(null);
  const inputRef = useRef(null);

  const push = (m) => setMessages((prev) => [...prev, m]);
  const append = (id, text) =>
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, text: (m.text || "") + text } : m)));

  useEffect(() => {
    msgsRef.current?.scrollTo({ top: msgsRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, usage, status]);

  useEffect(() => {
    inputRef.current?.focus();
  }, [status]);

  useEffect(() => {
    const es = new EventSource(`/conversations/${id}/events`);
    es.addEventListener("open", () => setStatus((s) => (s === "conectando" ? "conectado" : s)));
    es.addEventListener("started", () => setStatus("conectado"));
    es.addEventListener("chunk", (e) => {
      const text = JSON.parse(e.data).text;
      if (currentBot.current == null) {
        currentBot.current = ++idRef.current;
        push({ id: currentBot.current, role: "bot", text });
      } else {
        append(currentBot.current, text);
      }
      setStreaming(true);
    });
    es.addEventListener("tool", (e) => push({ id: ++idRef.current, role: "tool", text: JSON.parse(e.data).title }));
    es.addEventListener("usage", (e) => setUsage(JSON.parse(e.data)));
    es.addEventListener("done", () => { currentBot.current = null; setStreaming(false); setStatus("listo"); });
    es.addEventListener("error", () => setStatus("error"));
    es.addEventListener("closed", () => { currentBot.current = null; setStreaming(false); setStatus("cerrado"); });
    return () => es.close();
  }, [id]);

  async function send() {
    const text = input.trim();
    if (!text || status === "cerrado") return;
    setInput("");
    push({ id: ++idRef.current, role: "user", text });
    setStatus("pensando");
    inputRef.current?.focus();
    await fetch(`/conversations/${id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  }

  const thinking = status === "pensando";

  return (
    <div className="chat">
      <header className="chat-head">
        <Link to="/" className="brand" title="Nueva conversación">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
        </Link>
        <div className="agent">
          <span className="avatar">G</span>
          <div className="agent-meta">
            <strong>Gansito</strong>
            <span className={`status-line st-${status}`}>
              <span className="dot" />
              {status === "conectando" && "conectando…"}
              {status === "conectado" && "en línea"}
              {status === "pensando" && "pensando…"}
              {status === "listo" && "listo"}
              {status === "error" && "error"}
              {status === "cerrado" && "sesión cerrada"}
            </span>
          </div>
        </div>
      </header>

      <main className="msgs" ref={msgsRef}>
        {messages.length === 0 && (
          <div className="empty">
            <span className="avatar big">G</span>
            <p>Hola, soy <strong>Gansito</strong>. ¿En qué te ayudo?</p>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.role === "tool" ? (
              <span className="tool-chip">🔧 {m.text}</span>
            ) : m.role === "bot" ? (
              <>
                <div className="md"><Streamdown>{m.text || ""}</Streamdown></div>
                {usage && <div className="u">{usage.used.toLocaleString()} / {usage.size.toLocaleString()} tok · ${usage.cost.toFixed(6)}</div>}
              </>
            ) : (
              m.text
            )}
          </div>
        ))}

        {thinking && (
          <div className="msg bot">
            <div className="typing">
              <span /><span /><span />
            </div>
          </div>
        )}
      </main>

      <footer className="chat-foot">
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
          placeholder="Escribe tu mensaje…"
          disabled={status === "cerrado"}
          aria-label="Mensaje"
        />
        <button
          onClick={send}
          disabled={status === "cerrado" || !input.trim()}
          className="send"
          aria-label="Enviar"
          title="Enviar"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
        </button>
      </footer>
    </div>
  );
}
