"""A tiny to-do list, used to try Dispatch. One test fails on purpose."""


class TodoList:
    def __init__(self):
        self.items = []

    def add(self, title):
        if not title.strip():
            raise ValueError("title must not be empty")
        self.items.append({"title": title.strip(), "done": False})
        return len(self.items) - 1

    def complete(self, index):
        self.items[index]["done"] = True

    def remaining(self):
        """Number of items that are not done yet."""
        return len([item for item in self.items if item["done"]])
