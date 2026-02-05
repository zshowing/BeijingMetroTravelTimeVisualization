#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""Generate a static interactive Beijing subway isochrone map web page."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from glob import glob
from pathlib import Path
from typing import Any

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

try:
    from PIL import Image  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    Image = None  # type: ignore

from src.city.city import parse_city, City
from src.city.transfer import Transfer
from src.graph.map import parse_map, Map


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate static isochrone web page.")
    parser.add_argument("--city-root", default="data/beijing", help="City data root")
    parser.add_argument("--map-name", default="Official Map", help="Map name in maps/*.json5")
    parser.add_argument("--map-file", default=None, help="Override map json5 path")
    parser.add_argument("--output", default="./", help="Output directory")
    parser.add_argument("--speed-factor", type=float, default=0.6, help="Design speed multiplier")
    parser.add_argument("--dwell-minutes", type=float, default=0.5, help="Per-segment dwell time")
    parser.add_argument("--default-transfer-minutes", type=float, default=4.0, help="Fallback transfer time")
    parser.add_argument("--grid-size", default="240x160", help="Grid size, e.g. 240x160")
    parser.add_argument("--levels", default="10,20,30,40,50,60,90,120", help="Isochrone levels in minutes")
    return parser.parse_args()


def select_map(city: City, map_name: str, map_file: str | None) -> Map:
    if map_file:
        return parse_map(map_file, city.station_lines)
    map_dir = os.path.join(city.root, "maps")
    for map_path in glob(os.path.join(map_dir, "*.json5")):
        map_obj = parse_map(map_path, city.station_lines)
        if map_obj.name == map_name:
            return map_obj
    raise FileNotFoundError(f"Map '{map_name}' not found in {map_dir}")


def get_image_size(path: Path) -> tuple[int, int]:
    if Image is not None:
        with Image.open(path) as img:  # type: ignore[attr-defined]
            return img.size

    with path.open("rb") as fp:
        header = fp.read(24)
        if header.startswith(b"\x89PNG\r\n\x1a\n"):
            width = int.from_bytes(header[16:20], "big")
            height = int.from_bytes(header[20:24], "big")
            return width, height
        if header[0:2] == b"\xff\xd8":
            fp.seek(2)
            while True:
                marker = fp.read(1)
                while marker != b"\xff":
                    marker = fp.read(1)
                marker = fp.read(1)
                while marker == b"\xff":
                    marker = fp.read(1)
                if marker in {
                    b"\xc0", b"\xc1", b"\xc2", b"\xc3",
                    b"\xc5", b"\xc6", b"\xc7", b"\xc9",
                    b"\xca", b"\xcb", b"\xcd", b"\xce", b"\xcf"
                }:
                    fp.read(3)
                    height = int.from_bytes(fp.read(2), "big")
                    width = int.from_bytes(fp.read(2), "big")
                    return width, height
                length = int.from_bytes(fp.read(2), "big")
                fp.seek(length - 2, os.SEEK_CUR)
        raise ValueError(f"Unsupported image format: {path}")


def segment_minutes(dist_m: float, design_speed_kmh: float, speed_factor: float, dwell_minutes: float) -> float:
    speed_kmh = max(10.0, design_speed_kmh * speed_factor)
    meters_per_min = speed_kmh * 1000.0 / 60.0
    return dist_m / meters_per_min + dwell_minutes


def min_transfer_minutes(transfer: Transfer | None, line_a: str, line_b: str) -> float | None:
    if transfer is None:
        return None
    candidates: list[float] = []
    for (from_l, _, to_l, _), minutes in transfer.transfer_time.items():
        if {from_l, to_l} == {line_a, line_b}:
            candidates.append(minutes)
    for (from_l, _, to_l, _), (minutes, _) in transfer.special_time.items():
        if {from_l, to_l} == {line_a, line_b}:
            candidates.append(minutes)
    return min(candidates) if candidates else None


def build_graph_data(
    city: City,
    speed_factor: float,
    dwell_minutes: float,
    default_transfer_minutes: float,
) -> tuple[list[list[Any]], list[list[list[float]]], dict[str, list[int]]]:
    nodes: list[list[Any]] = []
    node_index: dict[tuple[str, str], int] = {}
    station_nodes: dict[str, list[int]] = {}

    def get_node(station: str, line_name: str) -> int:
        key = (station, line_name)
        if key not in node_index:
            node_index[key] = len(nodes)
            nodes.append([station, line_name])
        station_nodes.setdefault(station, [])
        if node_index[key] not in station_nodes[station]:
            station_nodes[station].append(node_index[key])
        return node_index[key]

    edge_map: dict[int, dict[int, float]] = {}

    def add_edge(u: int, v: int, w: float) -> None:
        edge_map.setdefault(u, {})
        if v not in edge_map[u] or w < edge_map[u][v]:
            edge_map[u][v] = w

    # Line segments
    for line in city.lines.values():
        stations = line.stations
        dists = line.station_dists
        if not stations or not dists:
            continue
        for i, dist in enumerate(dists):
            if i == len(stations) - 1:
                if not line.loop:
                    continue
                a, b = stations[i], stations[0]
            else:
                a, b = stations[i], stations[i + 1]
            minutes = segment_minutes(dist, line.design_speed, speed_factor, dwell_minutes)
            u = get_node(a, line.name)
            v = get_node(b, line.name)
            add_edge(u, v, minutes)
            add_edge(v, u, minutes)

    # Transfers on same station
    for station, lines in city.station_lines.items():
        if len(lines) <= 1:
            continue
        line_list = sorted([line.name for line in lines])
        transfer = city.transfers.get(station)
        for i, line_a in enumerate(line_list):
            for line_b in line_list[i + 1:]:
                minutes = min_transfer_minutes(transfer, line_a, line_b)
                if minutes is None:
                    minutes = default_transfer_minutes
                u = get_node(station, line_a)
                v = get_node(station, line_b)
                add_edge(u, v, minutes)
                add_edge(v, u, minutes)

    # Virtual transfers (station to station)
    for (from_station, to_station), transfer in city.virtual_transfers.items():
        if from_station not in city.station_lines or to_station not in city.station_lines:
            continue
        for from_line in city.station_lines[from_station]:
            for to_line in city.station_lines[to_station]:
                minutes = min_transfer_minutes(transfer, from_line.name, to_line.name)
                if minutes is None:
                    minutes = default_transfer_minutes
                u = get_node(from_station, from_line.name)
                v = get_node(to_station, to_line.name)
                add_edge(u, v, minutes)
                add_edge(v, u, minutes)

    edges: list[list[list[float]]] = []
    for i in range(len(nodes)):
        targets = edge_map.get(i, {})
        edges.append([[int(to_idx), round(weight, 3)] for to_idx, weight in targets.items()])
    return nodes, edges, station_nodes


def build_station_data(city: City, map_obj: Map) -> list[dict[str, Any]]:
    stations: list[dict[str, Any]] = []
    for station, lines in city.station_lines.items():
        if station not in map_obj.coordinates:
            continue
        shape = map_obj.coordinates[station]
        if shape is None:
            continue
        x, y = shape.center_point()
        r = max(6, int(shape.max_width() / 2))
        stations.append({
            "name": station,
            "x": x,
            "y": y,
            "r": r,
            "lines": sorted(line.name for line in lines),
            "isTransfer": len(lines) > 1
        })
    stations.sort(key=lambda s: s["name"])
    return stations


def write_text(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")


def main() -> None:
    args = parse_args()
    city = parse_city(args.city_root)
    map_obj = select_map(city, args.map_name, args.map_file)

    output_dir = Path(args.output)
    asset_dir = output_dir / "assets"
    output_dir.mkdir(parents=True, exist_ok=True)
    asset_dir.mkdir(parents=True, exist_ok=True)

    image_path = Path(map_obj.path)
    image_target = asset_dir / image_path.name
    shutil.copy2(image_path, image_target)

    img_width, img_height = get_image_size(image_path)

    grid_cols, grid_rows = [int(x) for x in args.grid_size.lower().split("x")]
    levels = [int(x.strip()) for x in args.levels.split(",") if x.strip()]

    nodes, edges, station_nodes = build_graph_data(
        city,
        speed_factor=args.speed_factor,
        dwell_minutes=args.dwell_minutes,
        default_transfer_minutes=args.default_transfer_minutes,
    )
    stations = build_station_data(city, map_obj)

    line_colors = {
        line.name: (line.color if line.color is not None else "#333333")
        for line in city.lines.values()
    }

    data = {
        "meta": {
            "city": city.name,
            "mapName": map_obj.name,
            "image": f"assets/{image_path.name}",
            "imageWidth": img_width,
            "imageHeight": img_height,
            "levels": levels,
            "grid": {"cols": grid_cols, "rows": grid_rows},
            "speedFactor": args.speed_factor,
            "dwellMinutes": args.dwell_minutes,
            "defaultTransferMinutes": args.default_transfer_minutes,
        },
        "stations": stations,
        "stationNodes": station_nodes,
        "nodes": nodes,
        "edges": edges,
        "lineColors": line_colors,
    }

    write_text(output_dir / "data.js", "window.SUBWAY_DATA = " + json.dumps(
        data, ensure_ascii=False, indent=2
    ) + ";\n")

if __name__ == "__main__":
    main()
