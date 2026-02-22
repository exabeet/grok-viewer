# Contributing Guidelines

Thank you for your interest in Grok-Viewer.
Contributions of all kinds are welcome — bug fixes, improvements, documentation updates, and feature suggestions.

Please read the guidelines below before submitting a contribution.

---

##  How to Contribute

### 1. Fork the Repository

Create your own fork of the repository and work from there.

### 2. Create a Branch

Create a dedicated branch for your changes:

```bash
git checkout -b feature/your-feature-name
```

For bug fixes:

```bash
git checkout -b fix/short-description
```

Avoid committing directly to `main`.

### 3. Make Focused Changes

* Keep pull requests small and focused.
* Avoid mixing unrelated changes in a single PR.
* Update documentation if necessary.
* Ensure UI changes remain accessible.

---

##  Testing

Before submitting a PR:

* Make sure the project runs correctly.
* Check the browser console for errors.
* If you modified JavaScript files, run:

```bash
node --check filename.js
```

* Test the affected UI flows manually.

---

## Commit Messages

Write clear and descriptive commit messages.

Recommended format:

```
Short summary (50–72 characters)

Optional detailed explanation of what and why.
```

Example:

```
Improve Sequence modal clarity and accessibility
```

---

##  Pull Request Guidelines

When opening a Pull Request:

* Clearly explain the **motivation**
* Describe the **changes made**
* List the **files affected**
* Describe how the changes were **tested**
* Include screenshots for UI changes when possible

PRs may be reviewed and feedback may be requested before merging.

---

## What Not to Do

* Do not include unrelated refactors.
* Do not introduce external dependencies without discussion.
* Do not include obfuscated or minified code in PRs.
* Do not commit secrets, tokens, or API keys.

---

##  Questions or Suggestions

If you're unsure about a change, feel free to open an issue first to discuss the idea before implementing it.

---

Thank you for helping improve Grok-Viewer, guys.
I don't have much time to update it, so I'd be happy if any of you would step up.
