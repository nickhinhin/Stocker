import { MouseEvent, useRef, useState } from "react";
import { ChartSlice } from "../lib/calculations";

interface PieChartProps {
  segments: ChartSlice[];
  title?: string;
  itemLabel?: string;
  valueLabel?: string;
  weightLabel?: string;
  valueFormatter?: (value: number) => string;
}

function polarToCartesian(cx: number, cy: number, r: number, angle: number): { x: number; y: number } {
  const radians = ((angle - 90) * Math.PI) / 180;
  return {
    x: cx + r * Math.cos(radians),
    y: cy + r * Math.sin(radians),
  };
}

function describeArc(
  cx: number,
  cy: number,
  outerRadius: number,
  innerRadius: number,
  startAngle: number,
  endAngle: number,
): string {
  const startOuter = polarToCartesian(cx, cy, outerRadius, endAngle);
  const endOuter = polarToCartesian(cx, cy, outerRadius, startAngle);
  const startInner = polarToCartesian(cx, cy, innerRadius, endAngle);
  const endInner = polarToCartesian(cx, cy, innerRadius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";

  return [
    `M ${startOuter.x.toFixed(2)} ${startOuter.y.toFixed(2)}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArcFlag} 0 ${endOuter.x.toFixed(2)} ${endOuter.y.toFixed(2)}`,
    `L ${endInner.x.toFixed(2)} ${endInner.y.toFixed(2)}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArcFlag} 1 ${startInner.x.toFixed(2)} ${startInner.y.toFixed(2)}`,
    "Z",
  ].join(" ");
}

function formatNumber(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export default function PieChart({
  segments,
  title,
  itemLabel = "Asset",
  valueLabel = "Value",
  weightLabel = "Weight",
  valueFormatter,
}: PieChartProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; lines: string[] } | null>(null);
  const filtered = segments
    .filter((segment) => segment.value > 0)
    .map((segment) => ({
      ...segment,
      label: String(segment.label ?? "").trim() || "Other",
    }));

  if (filtered.length === 0) {
    return (
      <div className="chart-empty compact">
        <span>No data</span>
      </div>
    );
  }

  const total = filtered.reduce((sum, segment) => sum + segment.value, 0);
  const formatValue = (value: number): string => (valueFormatter ? valueFormatter(value) : formatNumber(value));
  let currentAngle = 0;

  const showTooltip = (event: MouseEvent<Element>, lines: string[]): void => {
    if (!hostRef.current) {
      return;
    }
    const rect = hostRef.current.getBoundingClientRect();
    const rawX = event.clientX - rect.left + 12;
    const rawY = event.clientY - rect.top + 12;
    const maxX = Math.max(12, rect.width - 200);
    const maxY = Math.max(12, rect.height - 90);
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
      <div className="pie-layout">
        <svg className="pie-svg" viewBox="0 0 220 220" aria-label={title ?? "pie chart"}>
          {filtered.map((segment, index) => {
            const angle = (segment.value / total) * 360;
            const startAngle = currentAngle;
            const endAngle = currentAngle + angle;
            currentAngle = endAngle;

            const percent = (segment.value / total) * 100;
            const tooltipLines = [
              segment.label,
              `${valueLabel}: ${formatValue(segment.value)}`,
              `${percent.toFixed(1)}%`,
            ];
            const isFullCircle = percent >= 99.999;

            if (isFullCircle) {
              return (
                <circle
                  key={segment.label}
                  cx="110"
                  cy="110"
                  r="70"
                  fill="none"
                  stroke={segment.color}
                  strokeWidth="36"
                  className={`pie-slice ${index === hoveredIndex ? "selected" : ""}`}
                  onMouseEnter={(event) => {
                    setHoveredIndex(index);
                    showTooltip(event, tooltipLines);
                  }}
                  onMouseMove={(event) => showTooltip(event, tooltipLines)}
                />
              );
            }

            return (
              <path
                key={segment.label}
                d={describeArc(110, 110, 88, 52, startAngle, endAngle)}
                fill={segment.color}
                className={`pie-slice ${index === hoveredIndex ? "selected" : ""}`}
                onMouseEnter={(event) => {
                  setHoveredIndex(index);
                  showTooltip(event, tooltipLines);
                }}
                onMouseMove={(event) => showTooltip(event, tooltipLines)}
              />
            );
          })}
          <text x="110" y="103" textAnchor="middle" className="pie-total-label">
            Total
          </text>
          <text x="110" y="124" textAnchor="middle" className="pie-total-value">
            {formatNumber(total)}
          </text>
        </svg>

        <div className="pie-legend">
          <div className="pie-legend-head">
            <span />
            <span>{itemLabel}</span>
            <span className="value">{valueLabel}</span>
            <span className="weight">{weightLabel}</span>
          </div>
          {filtered.map((segment, index) => (
            <div
              key={segment.label}
              className={`pie-legend-row pie-legend-hover ${index === hoveredIndex ? "selected" : ""}`}
              onMouseEnter={(event) => {
                setHoveredIndex(index);
                showTooltip(event, [
                  segment.label,
                  `${valueLabel}: ${formatValue(segment.value)}`,
                  `${((segment.value / total) * 100).toFixed(1)}%`,
                ]);
              }}
              onMouseMove={(event) =>
                showTooltip(event, [
                  segment.label,
                  `${valueLabel}: ${formatValue(segment.value)}`,
                  `${((segment.value / total) * 100).toFixed(1)}%`,
                ])
              }
            >
              <span className="dot" style={{ background: segment.color }} />
              <span className="label">{segment.label}</span>
              <span className="value">{formatValue(segment.value)}</span>
              <strong>{((segment.value / total) * 100).toFixed(1)}%</strong>
            </div>
          ))}
        </div>
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
