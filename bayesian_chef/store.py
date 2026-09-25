"""Run log: one CSV row per run, stored next to the project file."""

from __future__ import annotations

import csv
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from .project import Project, Run

META = ["run_id", "session", "status", "phase", "created", "code"]
TAIL = ["notes"]


@dataclass
class Record:
    """One row of the run log: a run's recipe, status, results and notes."""
    run_id: str
    session: int
    status: str            # planned | done | rejected
    phase: str             # doe | bo | baseline | manual
    run: Run
    outputs: dict[str, float | None] = field(default_factory=dict)
    created: str = ""
    code: str = ""         # blind tasting code
    notes: str = ""


class Log:
    """The run log, stored as a CSV next to the project file."""
    def __init__(self, project: Project, path: Path | None = None):
        """Open (or start) the log for a project."""
        self.project = project
        self.path = path or project.path.with_suffix(".runs.csv")
        self.records: list[Record] = self._read()

    def _read(self) -> list[Record]:
        """Load all records from the CSV, if it exists."""
        if not self.path.exists():
            return []
        out = []
        with open(self.path, newline="") as f:
            for row in csv.DictReader(f):
                out.append(Record(
                    run_id=row["run_id"],
                    session=int(row["session"]),
                    status=row["status"],
                    phase=row["phase"],
                    run={fa.name: fa.parse(row[fa.name]) for fa in self.project.factors},
                    outputs={
                        o.name: float(row[o.name]) if row.get(o.name, "").strip() else None
                        for o in self.project.outputs
                    },
                    created=row.get("created", ""),
                    code=row.get("code", ""),
                    notes=row.get("notes", ""),
                ))
        return out

    def save(self) -> None:
        """Write every record back to the CSV."""
        p = self.project
        cols = META + [f.name for f in p.factors] + [o.name for o in p.outputs] + TAIL
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.path, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=cols)
            w.writeheader()
            for r in self.records:
                w.writerow(
                    {"run_id": r.run_id, "session": r.session, "status": r.status, "phase": r.phase,
                     "created": r.created, "code": r.code, "notes": r.notes}
                    | {fa.name: _fmt(r.run[fa.name]) for fa in p.factors}
                    | {o.name: "" if r.outputs.get(o.name) is None else _fmt(r.outputs[o.name]) for o in p.outputs}
                )

    # --------------------------------------------------------------- queries

    def next_session(self) -> int:
        """The next session number."""
        return max((r.session for r in self.records), default=0) + 1

    def next_id(self) -> str:
        """The next run id, like R012."""
        return f"R{len(self.records) + 1:03d}"

    def by_status(self, status: str) -> list[Record]:
        """Records with the given status: planned, done or rejected."""
        return [r for r in self.records if r.status == status]

    def get(self, run_id: str) -> Record:
        """Find a record by run id."""
        for r in self.records:
            if r.run_id.lower() == run_id.lower():
                return r
        raise KeyError(f"no run {run_id}")

    def results(self) -> list[dict]:
        """Completed runs in the shape the optimiser expects."""
        return [{"run": r.run, **r.outputs} for r in self.by_status("done")]

    def add(self, run: Run, session: int, phase: str, code: str = "", status: str = "planned") -> Record:
        """Append a new record and return it."""
        rec = Record(
            run_id=self.next_id(), session=session, status=status, phase=phase, run=run,
            outputs={o.name: None for o in self.project.outputs},
            created=datetime.now().isoformat(timespec="minutes"), code=code,
        )
        self.records.append(rec)
        return rec


def _fmt(v) -> str:
    """Format a value for the CSV."""
    if isinstance(v, float):
        return f"{v:.6g}"
    return str(v)
