export function throttle(func: () => void, delayMs: number) {
  let lastTime = 0;
  let timer: NodeJS.Timeout | null = null;

  const throttled = () => {
    const now = Date.now();
    const elapsed = now - lastTime;

    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    if (elapsed >= delayMs) {
      lastTime = now;
      func();
    } else {
      timer = setTimeout(() => {
        timer = null;
        lastTime = Date.now();
        func();
      }, delayMs - elapsed);
    }
  };

  throttled.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    lastTime = 0;
  };

  throttled.finish = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    lastTime = Date.now();
    func();
  };

  return throttled;
}
