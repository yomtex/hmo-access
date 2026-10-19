"use client";
export function PrintButton() {
  return <button className="secondary noprint" onClick={() => window.print()}>Print</button>;
}
