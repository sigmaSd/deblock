// No blocking calls — should pass cleanly.

export async function fetchData(url: string) {
  const res = await fetch(url);
  return await res.json();
}

export function syncHelper(x: number): number {
  return x * 2;
}

export async function composed() {
  const data = await fetchData("https://example.com");
  return syncHelper(data.value);
}
