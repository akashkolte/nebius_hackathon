# nebius_hackathon

A minimal multi-agent coding system with three coordinated agents:

- **planner**: breaks a coding request into clear implementation steps
- **coder**: produces an implementation summary from the plan
- **reviewer**: validates that implementation and tests are present

## Run

```bash
python /home/runner/work/nebius_hackathon/nebius_hackathon/multi_agent.py "implement user login flow"
```

## Test

```bash
cd /home/runner/work/nebius_hackathon/nebius_hackathon
python -m unittest discover -s tests -p "test_*.py"
```
