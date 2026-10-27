// Source value helper has no compiled iOS callsite; it is not a mounted View.
export class OutputScrollOffsetPreferenceKey {
  static readonly DEFAULT_VALUE: number = 0;

  static reduce(value: number, nextValue: () => number): number {
    return nextValue();
  }
}
