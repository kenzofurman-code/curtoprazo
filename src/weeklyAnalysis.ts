export async function requestWeeklyAnalysis(apiKey: string, prompt: string, signal: AbortSignal, fetcher: typeof fetch = fetch) {
  const response = await fetcher(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 1024 }
      })
    }
  );
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    if (response.status === 429) throw new Error('O limite de uso da API do Google foi atingido. Aguarde a liberação da cota antes de gerar novamente.');
    throw new Error(error?.error?.message || `Erro HTTP ${response.status}`);
  }
  const data = await response.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || 'Nenhuma resposta recebida.';
}
