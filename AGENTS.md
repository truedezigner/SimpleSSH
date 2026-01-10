## Agent Workflow Confirmation

When the user replies with a positive confirmation such as "good", "awesome", or "yes":
- Treat it as approval to repeat the same workflow or task sequence that was just completed.
- Before executing that repeated workflow, always ask for a clear Y/N confirmation.

If the user does not explicitly confirm with Y/N, do not run the repeated workflow.

If a task runs long or involves many changes, proactively remind the user to commit
so work is not lost. Do not require "good/yes" to proceed; just ask whether they want
to push to origin (e.g., "Can I push to origin?") and wait for a yes/no response.
