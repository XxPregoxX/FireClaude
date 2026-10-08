// Preço de API (US$ por milhão de tokens, 2026-10): entrada, escrita de cache 5 min, escrita 1 h, leitura de cache,
// saída. O plano por assinatura não cobra assim, mas é a melhor régua pra comparar modelos e conversas.
// Haiku 5.5: preço até 100 mil tokens de prompt (o modelo auxiliar nunca passa de 50 mil).
export const PRECOS = {
  "claude-opus-5-5": [4.0, 5.0, 8.0, 0.2, 20.0],
  "claude-sonnet-5-5": [2.0, 2.5, 4.0, 0.1, 10.0],
  "claude-haiku-5-5": [0.1, 0.125, 0.2, 0.01, 0.5],
  "claude-haiku-4-5": [1.0, 1.25, 2.0, 0.1, 5.0],
};

const tabela = (modelo) => Object.entries(PRECOS).find(([k]) => String(modelo || "").startsWith(k))?.[1] || null;

// usage no formato da API (input_tokens, cache_creation_input_tokens, cache_creation.ephemeral_1h_input_tokens,
// cache_read_input_tokens, output_tokens) -> US$ (0 se o modelo não está na tabela).
export function custoUsd(modelo, u = {}) {
  const p = tabela(modelo);
  if (!p) return 0;
  const h1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const m5 = u.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens || 0) - h1);
  return ((u.input_tokens || 0) * p[0] + m5 * p[1] + h1 * p[2] + (u.cache_read_input_tokens || 0) * p[3] + (u.output_tokens || 0) * p[4]) / 1e6;
}
