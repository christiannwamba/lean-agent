import renderMarkdownToTerminal from 'cli-markdown';

export function renderAssistantOutput(markdown: string): string {
  const trimmed = markdown.trim();
  if (!trimmed) {
    return '';
  }

  try {
    return renderMarkdownToTerminal(trimmed).trimEnd();
  } catch {
    return trimmed;
  }
}
