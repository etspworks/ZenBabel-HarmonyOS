// iOS reads launch text from the process arguments (PreBabelLensApp.extractLaunchInputText). HarmonyOS apps get no
// argv; the same list arrives as the Want parameter 'launchArguments', a JSON array of strings, e.g.
//   aa start -b <bundle> -a EntryAbility --ps launchArguments '["One","Two","Three"]'
export class LaunchArguments {
  static readonly PARAMETER: string = 'launchArguments';

  /** The argument list from a Want parameter value: a JSON string array, or a single plain string. */
  static parse(value: Object | undefined): string[] {
    if (typeof value !== 'string' || value.length === 0) {
      return [];
    }
    try {
      const parsed: Object = JSON.parse(value) as Object;
      if (Array.isArray(parsed)) {
        return (parsed as Object[]).filter((item: Object) => typeof item === 'string').map((item: Object) => item as string);
      }
    } catch (error) {
      // not JSON: one argument
    }
    return [value];
  }

  /** Text arguments joined with spaces: '--' ends option parsing, '-x' options are skipped, and
   *  -AppleLanguages / -AppleLocale also skip their value. Undefined when nothing is left. */
  static extractLaunchInputText(args: string[]): string | undefined {
    const textArgs: string[] = [];
    let index: number = 0;
    while (index < args.length) {
      const arg: string = args[index];
      if (arg === '--') {
        textArgs.push(...args.slice(index + 1));
        break;
      }
      if (arg.startsWith('-')) {
        index += LaunchArguments.optionConsumesValue(arg) && index + 1 < args.length && !args[index + 1].startsWith('-') ? 2 : 1;
        continue;
      }
      textArgs.push(arg);
      index += 1;
    }
    const trimmed: string = textArgs.join(' ').trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }

  private static optionConsumesValue(option: string): boolean {
    return option === '-AppleLanguages' || option === '-AppleLocale';
  }
}
