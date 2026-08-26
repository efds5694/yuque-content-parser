function mergeSegments(segments) {
  const merged = [];
  for (const segment of segments) {
    if (!segment.text) continue;
    const last = merged.at(-1);
    if (last?.type === segment.type) last.text += segment.text;
    else merged.push({ ...segment });
  }
  return merged;
}

// Myers diff。按 Unicode 码点比较，再换算成 DOM Range 使用的 UTF-16 偏移。
export function diffSegments(oldText, newText) {
  const before = Array.from(oldText);
  const after = Array.from(newText);
  const n = before.length;
  const m = after.length;
  const max = n + m;
  let frontier = new Map([[1, 0]]);
  const trace = [];

  for (let distance = 0; distance <= max; distance += 1) {
    trace.push(new Map(frontier));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down = diagonal === -distance
        || (diagonal !== distance && (frontier.get(diagonal - 1) ?? -1) < (frontier.get(diagonal + 1) ?? -1));
      let x = down ? (frontier.get(diagonal + 1) ?? 0) : (frontier.get(diagonal - 1) ?? 0) + 1;
      let y = x - diagonal;
      while (x < n && y < m && before[x] === after[y]) {
        x += 1;
        y += 1;
      }
      frontier.set(diagonal, x);
      if (x >= n && y >= m) return backtrack(trace, before, after, distance);
    }
  }
  return [];
}

function backtrack(trace, before, after, finalDistance) {
  let x = before.length;
  let y = after.length;
  const reversed = [];

  for (let distance = finalDistance; distance >= 0; distance -= 1) {
    const frontier = trace[distance];
    const diagonal = x - y;
    const down = diagonal === -distance
      || (diagonal !== distance && (frontier.get(diagonal - 1) ?? -1) < (frontier.get(diagonal + 1) ?? -1));
    const previousDiagonal = down ? diagonal + 1 : diagonal - 1;
    const previousX = frontier.get(previousDiagonal) ?? 0;
    const previousY = previousX - previousDiagonal;

    while (x > previousX && y > previousY) {
      reversed.push({ type: "equal", text: before[x - 1] });
      x -= 1;
      y -= 1;
    }
    if (distance === 0) break;
    if (down) {
      reversed.push({ type: "insert", text: after[previousY] });
      y -= 1;
    } else {
      reversed.push({ type: "delete", text: before[previousX] });
      x -= 1;
    }
  }
  return mergeSegments(reversed.reverse());
}

export function diffToHunks(oldText, newText) {
  if (oldText === newText) return [];
  const segments = diffSegments(oldText, newText);
  const hunks = [];
  let oldOffset = 0;
  let active = null;

  const flush = () => {
    if (!active) return;
    active.oldText = oldText.slice(active.start, active.end);
    hunks.push(active);
    active = null;
  };

  for (const segment of segments) {
    if (segment.type === "equal") {
      flush();
      oldOffset += segment.text.length;
      continue;
    }
    if (!active) active = { start: oldOffset, end: oldOffset, oldText: "", newText: "" };
    if (segment.type === "delete") {
      oldOffset += segment.text.length;
      active.end = oldOffset;
    } else {
      active.newText += segment.text;
    }
  }
  flush();
  return hunks;
}

export function applyHunks(oldText, hunks) {
  let value = oldText;
  for (const hunk of [...hunks].sort((a, b) => b.start - a.start)) {
    value = `${value.slice(0, hunk.start)}${hunk.newText}${value.slice(hunk.end)}`;
  }
  return value;
}
