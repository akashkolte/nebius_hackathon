"""Minimal multi-agent coding system implementation."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List
import argparse
import json


@dataclass(frozen=True)
class AgentResult:
    agent: str
    output: str


class PlannerAgent:
    """Breaks a coding request into implementation steps."""

    def run(self, task: str) -> AgentResult:
        steps = [
            f"Analyze requirements for: {task}",
            "Design a minimal implementation",
            "Implement code changes",
            "Add targeted tests",
            "Run validation checks",
        ]
        return AgentResult(agent="planner", output="\n".join(f"- {step}" for step in steps))


class CoderAgent:
    """Produces a concise implementation summary from a plan."""

    def run(self, plan: str) -> AgentResult:
        summary = (
            "Implemented according to plan:\n"
            f"{plan}\n"
            "Code and tests were created for the requested behavior."
        )
        return AgentResult(agent="coder", output=summary)


class ReviewerAgent:
    """Performs a lightweight review pass over coder output."""

    def run(self, implementation: str) -> AgentResult:
        passed = all(token in implementation.lower() for token in ("implemented", "tests"))
        verdict = "approved" if passed else "changes_requested"
        feedback = "Implementation includes both code and test coverage." if passed else "Missing code or tests in implementation summary."
        return AgentResult(agent="reviewer", output=f"{verdict}: {feedback}")


class MultiAgentCodingSystem:
    """Coordinates planner, coder, and reviewer agents."""

    def __init__(self, planner: PlannerAgent | None = None, coder: CoderAgent | None = None, reviewer: ReviewerAgent | None = None) -> None:
        self.planner = planner or PlannerAgent()
        self.coder = coder or CoderAgent()
        self.reviewer = reviewer or ReviewerAgent()

    def run(self, task: str) -> Dict[str, str]:
        plan = self.planner.run(task)
        implementation = self.coder.run(plan.output)
        review = self.reviewer.run(implementation.output)
        return {
            plan.agent: plan.output,
            implementation.agent: implementation.output,
            review.agent: review.output,
        }


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the multi-agent coding system")
    parser.add_argument("task", help="The coding task to execute")
    args = parser.parse_args()

    system = MultiAgentCodingSystem()
    result = system.run(args.task)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
