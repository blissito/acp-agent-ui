/**
 * Shim de i18n — el Desktop usa react-intl; aquí sólo necesitamos el texto por
 * defecto. Mantener la misma firma permite copiar componentes sin editarlos.
 */
import type { ReactNode } from "react";

export type MessageDescriptor = { id: string; defaultMessage: string };

export function defineMessages<T extends Record<string, MessageDescriptor>>(messages: T): T {
  return messages;
}

type Values = Record<string, ReactNode>;

function format(descriptor: MessageDescriptor, values?: Values): string {
  const raw = descriptor?.defaultMessage ?? "";
  if (!values) return raw;
  // Interpolación mínima de {placeholders}, suficiente para los textos portados.
  return raw.replace(/\{(\w+)\}/g, (match, key) =>
    key in values ? String(values[key]) : match
  );
}

export function useIntl() {
  return { formatMessage: format };
}

export function FormattedMessage({ id, defaultMessage }: MessageDescriptor) {
  return <>{defaultMessage}</>;
}
