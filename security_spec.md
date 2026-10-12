# Security Specification

## Data Invariants
- A user cannot change their own role unless they are the super admin email.
- `items` can only be updated by authenticated users.
- Creating an `item` (a Kanban Box) requires Admin role.
- Deleting an `item` requires Admin role.
- Updating `items`:
  - Changing limits requires Admin or Manager role.
  - Adding quantity requires Warehouse, Manager, or Admin role.
  - Taking quantity (removing) requires Operator or higher (so anyone authenticated).
- `transactions` are append-only. Only Admin can possibly delete/manage them if needed, but for now they are create-only for regular users.

## The "Dirty Dozen" Payloads
1. Attempt to create a user with "Admin" role if not the owner email.
2. Attempt to update another user's role.
3. Attempt to change a kanban box limit as an Operator.
4. Attempt to add stock to a kanban box as an Operator.
5. Attempt to create a document with an ID that is 1MB of junk.
6. Attempt to delete a transaction.
7. Attempt to modify a transaction's quantity post-creation.
8. Attempt to read other users' settings as a regular Operator.
9. Attempt to create a transaction without matching `userId`.
10. Attempt to spoof timestamps on a transaction.
11. Attempt to add a transaction where the `type` is neither `ADD` nor `REMOVE`.
12. Attempt to change another user's email notification settings without being an Admin.

## The Test Runner
To be generated next in `firestore.rules.test.ts`.
