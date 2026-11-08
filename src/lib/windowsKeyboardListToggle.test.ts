import {
  effectiveWindowsInsertionMode,
  showWindowsOpenlessKeyboardListToggle,
  showWindowsSendInputNewlineMode,
} from './windowsKeyboardListToggle';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

assert(
  effectiveWindowsInsertionMode(undefined, true) === 'sendInput',
  'legacy true should resolve to sendInput',
);
assert(
  effectiveWindowsInsertionMode(undefined, false) === 'sendInput',
  'legacy false should migrate to sendInput',
);
assert(
  effectiveWindowsInsertionMode(undefined, undefined) === 'sendInput',
  'missing mode and legacy should default to sendInput',
);

assert(showWindowsOpenlessKeyboardListToggle('tsf'), 'legacy tsf should migrate to non-TSF behavior');
assert(
  showWindowsOpenlessKeyboardListToggle('sendInput'),
  'sendInput should show keyboard list toggle',
);
assert(showWindowsOpenlessKeyboardListToggle('paste'), 'paste should show keyboard list toggle');
assert(
  showWindowsOpenlessKeyboardListToggle(undefined, true),
  'legacy sendInput-only should show keyboard list toggle',
);

assert(
  showWindowsOpenlessKeyboardListToggle('tsf', true),
  'legacy tsf should use non-TSF keyboard behavior',
);
assert(
  showWindowsSendInputNewlineMode('tsf', true),
  'legacy tsf should use the SendInput newline mode',
);

assert(
  showWindowsOpenlessKeyboardListToggle('paste', true),
  'explicit paste should show keyboard list toggle even with legacy true',
);
assert(
  !showWindowsSendInputNewlineMode('paste', true),
  'explicit paste should hide newline mode even with legacy true',
);

assert(showWindowsSendInputNewlineMode('sendInput'), 'sendInput should show newline mode');
assert(!showWindowsSendInputNewlineMode('paste'), 'paste should hide newline mode');
assert(showWindowsSendInputNewlineMode('tsf'), 'legacy tsf should migrate to SendInput newline mode');
assert(
  showWindowsSendInputNewlineMode(undefined, true),
  'legacy sendInput-only should show newline mode',
);

console.log('windowsKeyboardListToggle.test.ts: ok');
