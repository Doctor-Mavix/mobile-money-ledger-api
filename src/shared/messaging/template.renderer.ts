import nunjucks from 'nunjucks';

/**
 * Templates live on disk, outside the bundle, so a deployment can change the wording of an
 * email without a rebuild — and so the generated project ships editable files rather than
 * strings buried in compiled code.
 */
export class TemplateRenderer {
  private readonly environment: nunjucks.Environment;

  constructor(directory: string, cache: boolean) {
    this.environment = new nunjucks.Environment(
      new nunjucks.FileSystemLoader(directory, { noCache: !cache }),
      { autoescape: true },
    );
  }

  render(template: string, context: Record<string, unknown>): string {
    return this.environment.render(`${template}.njk`, context);
  }
}

/**
 * A plain-text alternative is what keeps a message out of the spam folder and readable in a
 * client that refuses HTML. Derived from the rendered body so the two can never drift.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h1|h2|h3|div|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
