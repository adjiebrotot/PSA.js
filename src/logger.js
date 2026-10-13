// SPDX-License-Identifier: MIT
/** Tiny logger with python-logging-like levels. */

const LEVELS = { debug: 10, info: 20, warning: 30, error: 40, silent: 100 };

export const logger = {
  level: LEVELS.warning,
  handler: (level, msg) => {
    const fn = level >= LEVELS.error ? console.error : level >= LEVELS.warning ? console.warn : console.log;
    fn(msg);
  },
  setLevel(name) {
    this.level = typeof name === "number" ? name : LEVELS[name] ?? LEVELS.warning;
  },
  _log(level, msg) {
    if (level >= this.level) this.handler(level, msg);
  },
  debug(msg) {
    this._log(LEVELS.debug, msg);
  },
  info(msg) {
    this._log(LEVELS.info, msg);
  },
  warning(msg) {
    this._log(LEVELS.warning, msg);
  },
  warn(msg) {
    this._log(LEVELS.warning, msg);
  },
  error(msg) {
    this._log(LEVELS.error, msg);
  },
  /** Run fn with a temporarily changed level. */
  withLevel(level, fn) {
    const old = this.level;
    this.setLevel(level);
    try {
      return fn();
    } finally {
      this.level = old;
    }
  },
};

export { LEVELS };
