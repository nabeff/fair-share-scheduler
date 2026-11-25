// The tests import describe, test and expect by name, so Testing Library does
// not find a global afterEach to hook into. Empty the page after every test here.
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(cleanup);
