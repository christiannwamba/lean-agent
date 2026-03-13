import { Command } from 'commander';

import { DEFAULT_REFERENCE_ISO, DEFAULT_TIMEZONE, parseDeadlineText } from './dates.js';

const program = new Command();

program
  .name('parse-date')
  .description('Parse a natural-language deadline into normalized storage fields')
  .argument('<text>', 'Natural-language deadline text')
  .option('--ref <iso>', 'Reference ISO instant', DEFAULT_REFERENCE_ISO)
  .option('--tz <timezone>', 'IANA timezone name', DEFAULT_TIMEZONE)
  .action((text: string, options: { ref: string; tz: string }) => {
    const parsed = parseDeadlineText(text, {
      referenceInstant: new Date(options.ref),
      timezone: options.tz,
    });

    if (!parsed) {
      console.log(JSON.stringify({ input: text, parsed: null }, null, 2));
      process.exit(1);
    }

    console.log(
      JSON.stringify(
        {
          input: text,
          referenceInstant: options.ref,
          timezone: options.tz,
          parsed,
        },
        null,
        2,
      ),
    );
  });

await program.parseAsync(process.argv);
