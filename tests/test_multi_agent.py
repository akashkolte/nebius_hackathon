import unittest

from multi_agent import MultiAgentCodingSystem


class MultiAgentSystemTests(unittest.TestCase):
    def test_run_returns_all_agent_outputs(self) -> None:
        system = MultiAgentCodingSystem()

        result = system.run("build an authentication endpoint")

        self.assertEqual(set(result.keys()), {"planner", "coder", "reviewer"})
        self.assertIn("Analyze requirements", result["planner"])
        self.assertIn("Implemented", result["coder"])
        self.assertIn("approved", result["reviewer"])


if __name__ == "__main__":
    unittest.main()
