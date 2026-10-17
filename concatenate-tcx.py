#!/usr/bin/env python3
"""Join sequential TCX recordings without resampling or discarding XML fields."""

import argparse
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
import sys
from xml.dom import minidom


TCX = "http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"
XMLNS = "http://www.w3.org/2000/xmlns/"


def children(element, name):
    return [node for node in element.childNodes
            if node.nodeType == node.ELEMENT_NODE
            and node.namespaceURI == TCX and node.localName == name]


def descendants(element, name):
    return list(element.getElementsByTagNameNS(TCX, name))


def text(element):
    return "".join(node.data for node in element.childNodes
                   if node.nodeType in (node.TEXT_NODE, node.CDATA_SECTION_NODE)).strip()


def number(element):
    try:
        value = Decimal(text(element))
    except InvalidOperation:
        raise ValueError(f"Invalid number in {element.tagName}") from None
    if not value.is_finite() or value < 0:
        raise ValueError(f"Expected a finite, nonnegative {element.tagName}")
    return value


def one(element, name):
    matches = children(element, name)
    if len(matches) != 1:
        raise ValueError(f"Expected one {name} inside {element.tagName}")
    return matches[0]


def timestamp(point):
    value = text(one(point, "Time"))
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise ValueError(f"Invalid trackpoint timestamp: {value}") from None
    if result.tzinfo is None:
        raise ValueError(f"Trackpoint timestamp needs a timezone: {value}")
    return result


def inspect(document):
    root = document.documentElement
    if root.namespaceURI != TCX or root.localName != "TrainingCenterDatabase":
        raise ValueError("Expected a TCX v2 TrainingCenterDatabase")
    container = one(root, "Activities")
    activity = one(container, "Activity")
    laps = children(activity, "Lap")
    if not laps:
        raise ValueError("Activity has no laps")
    points = [p for lap in laps for p in descendants(lap, "Trackpoint")]
    if not points:
        raise ValueError("Activity has no trackpoints")
    times = [timestamp(p) for p in points]
    if any(b <= a for a, b in zip(times, times[1:])):
        raise ValueError("Trackpoint timestamps must increase strictly")
    distances = [number(d) for p in points for d in children(p, "DistanceMeters")]
    if not distances:
        raise ValueError("Activity has no trackpoint distances")
    if any(b < a for a, b in zip(distances, distances[1:])):
        raise ValueError("Trackpoint distance resets within an input; use the original recordings")
    total = sum((number(one(lap, "DistanceMeters")) for lap in laps), Decimal(0))
    timer = sum((number(one(lap, "TotalTimeSeconds")) for lap in laps), Decimal(0))
    if abs(total - distances[-1]) > Decimal("1"):
        raise ValueError("Lap distance summaries and final trackpoint differ by more than 1 meter; "
                         "use the original recordings rather than an online merge")
    return dict(activity=activity, laps=laps, points=points, start=times[0], end=times[-1],
                total=total, timer=timer, final_distance=distances[-1])


def namespace_context(element):
    """Keep inherited declarations, including prefixes used only in xsi:type values."""
    declarations = {}
    while element.nodeType == element.ELEMENT_NODE:
        for attr in element.attributes.values():
            if attr.namespaceURI == XMLNS:
                declarations.setdefault(attr.name, attr.value)
        element = element.parentNode
    return declarations


def concatenate(paths, output):
    paths = [Path(p).resolve() for p in paths]
    output = Path(output).resolve()
    if len(paths) < 2:
        raise ValueError("Provide at least two original TCX recordings")
    if len(set(paths)) != len(paths):
        raise ValueError("The same input file was supplied more than once")
    if output in paths or output.exists():
        raise ValueError(f"Output already exists or is an input: {output}; choose a new filename")

    sources = []
    for path in paths:
        try:
            document = minidom.parse(str(path))
            sources.append((document, inspect(document)))
        except (ValueError, OSError) as error:
            raise ValueError(f"{path.name}: {error}") from error
    sources.sort(key=lambda source: source[1]["start"])
    sport = sources[0][1]["activity"].getAttribute("Sport")
    for (_, previous), (_, current) in zip(sources, sources[1:]):
        if current["start"] <= previous["end"]:
            raise ValueError("Recordings overlap in time; this command joins sequential recordings")
        if current["activity"].getAttribute("Sport") != sport:
            raise ValueError("All recordings must have the same Sport")

    # Clone the first document, retaining its activity ID, creator and metadata.
    result = sources[0][0].cloneNode(deep=True)
    activity = inspect(result)["activity"]
    existing_laps = children(activity, "Lap")
    insertion_point = existing_laps[-1].nextSibling
    for lap in existing_laps:
        activity.removeChild(lap)

    offset = Decimal(0)
    for _, source in sources:
        for original in source["laps"]:
            lap = result.importNode(original, deep=True)
            # A later file can use different extension prefixes. Preserve its
            # namespace scope locally instead of interpreting extension fields.
            for name, uri in namespace_context(original).items():
                lap.setAttributeNS(XMLNS, name, uri)
            for point in descendants(lap, "Trackpoint"):
                for distance in children(point, "DistanceMeters"):
                    value = number(distance) + offset
                    while distance.firstChild:
                        distance.removeChild(distance.firstChild)
                    distance.appendChild(result.createTextNode(str(value)))
            activity.insertBefore(lap, insertion_point)
        # Garmin summaries round to fewer decimals than trackpoint distances.
        # Use the larger value so rounding cannot introduce a backwards step.
        offset += max(source["total"], source["final_distance"])

    payload = result.toxml(encoding="utf-8")
    verified = inspect(minidom.parseString(payload))
    expected_points = sum(len(s[1]["points"]) for s in sources)
    expected_total = sum((s[1]["total"] for s in sources), Decimal(0))
    expected_timer = sum((s[1]["timer"] for s in sources), Decimal(0))
    if (len(verified["points"]) != expected_points or verified["total"] != expected_total
            or verified["timer"] != expected_timer):
        raise ValueError("Output verification failed")
    # Exclusive creation protects inputs and any existing output, even if a
    # different process creates the destination after the earlier check.
    with output.open("xb") as destination:
        destination.write(payload)
    return verified


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", nargs="+", help="Original TCX files (sorted by recording time)")
    parser.add_argument("-o", "--output", required=True, help="New output TCX file; never overwritten")
    args = parser.parse_args()
    try:
        verified = concatenate(args.inputs, args.output)
    except Exception as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    print(f"Created {Path(args.output).resolve()}")
    print(f"Distance: {verified['total'] / 1000:.5f} km; "
          f"recorded timer time: {verified['timer']} seconds")
    print(f"Laps: {len(verified['laps'])}; trackpoints: {len(verified['points'])}")
    print("Original timestamps, breaks, GPS and sensor fields preserved.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
