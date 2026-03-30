import { MouseEvent, useRef, useState } from "react";
import { ChartBarDatum } from "../lib/calculations";

interface BarChartProps {
  data: ChartBarDatum[];
  title?: string;
  positiveColor?: string;
  negativeColor?: string;
}

function clamp(value: number): number {
  if (value < 0) {
    return 0;
  }
  if (value > 100) {
    return 100;
  }
  return value;
}

export default function BarChart({
  data,
  title,
  positiveColor = "#2f9c82",
  negativeColor = "#d45353",
}: BarChartProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; lines: string[] } | null>(null);

  if (data.length === 0) {
    return (
      <div className="chart-empty compact">
        <span>No data</span>
      </div>
    );
  }

  const maxAbs = Math.max(...data.map((item) => Math.abs(item.value)), 1);

  const showTooltip = (event: MouseEvent<Element>, lines: string[]): void => {
    if (!hostRef.current) {
      return;
    }
    const rect = hostRef.current.getBoundingClientRect();
    const rawX = event.clientX - rect.left + 12;
    const rawY = event.clientY - rect.top + 12;
    const maxX = Math.max(12, rect.width - 190);
    const maxY = Math.max(12, rect.height - 88);
    setTooltip({
      x: Math.min(maxX, Math.max(12, rawX)),
      y: Math.min(maxY, Math.max(12, rawY)),
      lines,
    });
  };

  return (
    <div
      ref={hostRef}
      className="mini-chart-card chart-tooltip-host"
      onMouseLeave={() => {
        setHoveredIndex(null);
        setTooltip(null);
      }}
    >
      {title && <h4>{title}</h4>}
      <div className="bar-chart-wrap">
        {data.map((item, index) => {
          const pct = clamp((Math.abs(item.value) / maxAbs) * 100);
          const positive = item.value >= 0;
          const valueText = `${positive ? "+" : ""}${item.value.toLocaleString(undefined, {
            maximumFractionDigits: 2,
          })}`;
          return (
            <div
              key={`${item.label}-${index}`}
              className={`bar-row bar-row-hover ${index === hoveredIndex ? "selected" : ""}`}
              onMouseEnter={(event) => {
                setHoveredIndex(index);
                showTooltip(event, [item.label, `${title ?? "Value"}: ${valueText}`]);
              }}
              onMouseMove={(event) => showTooltip(event, [item.label, `${title ?? "Value"}: ${valueText}`])}
            >
              <span className="bar-label">{item.label}</span>
              <div className="bar-track">
                <div
                  className="bar-fill"
                  style={{
                    width: `${pct}%`,
                    background: positive ? positiveColor : negativeColor,
                  }}
                />
              </div>
              <strong className={positive ? "positive" : "negative"}>{item.value.toFixed(2)}</strong>
            </div>
          );
        })}
      </div>
      {tooltip && (
        <div className="chart-hover-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          {tooltip.lines.map((line, index) => (
            <div key={`${line}-${index}`} className="chart-hover-tooltip-line">
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
