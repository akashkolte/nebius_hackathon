import unittest

from todo import TodoList


class TodoListTest(unittest.TestCase):
    def test_add_returns_index(self):
        todos = TodoList()
        self.assertEqual(todos.add("write docs"), 0)
        self.assertEqual(todos.add("ship it"), 1)

    def test_empty_title_is_rejected(self):
        with self.assertRaises(ValueError):
            TodoList().add("   ")

    def test_remaining_counts_open_items(self):
        todos = TodoList()
        todos.add("write docs")
        todos.add("record demo")
        todos.add("ship it")
        todos.complete(0)
        self.assertEqual(todos.remaining(), 2)


if __name__ == "__main__":
    unittest.main()
