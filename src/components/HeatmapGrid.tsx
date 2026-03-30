import { MouseEvent, useRef, useState } from "react";
import { HeatmapData } from "../lib/calculations";

interface HeatmapGridProps {
  data: HeatmapData;
  title?: string;
}

function cellColor(value: number, maxValue: number): string {
  if (maxValue <= 0 || value <= 0) {
    return "#f2f5f9";
  }

  const ratio = value / maxValue;
  if (ratio > 0.8) {
    return "#1f8f6b";
  }
  if (ratio > 0.6) {
    return "#2ca87d";
  }
  if (ratio > 0.4) {
    return "#56be98";
  }
  if (ratio > 0.2) {
    return "#8fd2ba";
  }
  return "#c9e8dc";
}

export default function HeatmapGrid({ data, title }: HeatmapGridProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const [hoveredCell, setHoveredCell] = useState<{ rowIndex: number; colIndex: number } | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; lines: string[] } | null>(null);
  const { xLabels, yLabels, values, maxValue } = data;

  if (xLabels.length === 0 || yLabels.length === 0) {
    return (
      <div className="chart-empty compact">
        <span>No data</span>
      </div>
    );
  }

  const showTooltip = (event: MouseEvent<Element>, lines: string[]): void => {
    if (!hostRef.current) {
      return;
    }
    const rect = hostRef.current.getBoundingClientRect();
    const rawX = event.clientX - rect.left + 12;
    const rawY = event.clientY - rect.top + 12;
    const maxX = Math.max(12, rect.width - 210);
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
        setHoveredCell(null);
        setTooltip(null);
      }}
    >
      {title && <h4>{title}</h4>}
      <div className="heatmap-wrap">
        <table className="heatmap-table">
          <thead>
            <tr>
              <th />
              {xLabels.map((label) => (
                <th key={label}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {yLabels.map((rowLabel, rowIndex) => (
              <tr key={rowLabel}>
                <td className="row-head">{rowLabel}</td>
                {xLabels.map((_, colIndex) => {
                  const value = values[rowIndex]?.[colIndex] ?? 0;
                  return (
                    <td
                      key={`${rowLabel}-${colIndex}`}
                      className={`heat-cell ${
                        hoveredCell?.rowIndex === rowIndex && hoveredCell.colIndex === colIndex
                          ? "selected"
                          : ""
                      }`}
                      style={{ background: cellColor(value, maxValue) }}
                      onMouseEnter={(event) => {
                        setHoveredCell({ rowIndex, colIndex });
                        showTooltip(event, [rowLabel, `${xLabels[colIndex]}: ${value}`]);
                      }}
                      onMouseMove={(event) => showTooltip(event, [rowLabel, `${xLabels[colIndex]}: ${value}`])}
                    >
                      {value > 0 ? value : ""}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
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
