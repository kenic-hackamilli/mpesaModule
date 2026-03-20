type CircuitState = {
  failures: number;
  openedAt: number | null;
};

const states = new Map<string, CircuitState>();

const FAILURE_THRESHOLD = 3;
const OPEN_TIME_MS = 30_000;

export const runWithCircuitBreaker = async <T>(
  key: string,
  fn: () => Promise<T>,
  isFailure: (result: T) => boolean
) => {
  const state = states.get(key) ?? { failures: 0, openedAt: null };

  if (state.openedAt && Date.now() - state.openedAt < OPEN_TIME_MS) {
    throw new Error("Upstream service temporarily unavailable");
  }

  if (state.openedAt) {
    state.openedAt = null;
    state.failures = 0;
  }

  try {
    const result = await fn();
    if (isFailure(result)) {
      state.failures += 1;
      if (state.failures >= FAILURE_THRESHOLD) {
        state.openedAt = Date.now();
      }
    } else {
      state.failures = 0;
    }

    states.set(key, state);
    return result;
  } catch (err) {
    state.failures += 1;
    if (state.failures >= FAILURE_THRESHOLD) {
      state.openedAt = Date.now();
    }
    states.set(key, state);
    throw err;
  }
};
