import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

interface Props {
  label: string;
  name: string;
  options: string[];
}

/**
 * Custom select, following the WAI-ARIA "select-only combobox" pattern.
 * The value goes to the form through a hidden input.
 */
export function TenantPicker({ label, name, options }: Props) {
  const id = useId();
  const [chosen, setChosen] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  // Default to the first tenant.
  const value =
    chosen !== null && options.includes(chosen) ? chosen : (options[0] ?? "");
  const disabled = options.length === 0;

  useEffect(() => {
    if (!open) return;
    list.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);

  function show() {
    setActive(Math.max(0, options.indexOf(value)));
    setOpen(true);
  }

  function choose(index: number) {
    const option = options[index];
    if (option !== undefined) setChosen(option);
    setOpen(false);
  }

  function onKeyDown(event: KeyboardEvent) {
    if (disabled) return;
    const last = options.length - 1;
    const keys: Record<string, () => void> = open
      ? {
          ArrowDown: () => setActive((i) => Math.min(last, i + 1)),
          ArrowUp: () => setActive((i) => Math.max(0, i - 1)),
          Home: () => setActive(0),
          End: () => setActive(last),
          Enter: () => choose(active),
          " ": () => choose(active),
          Escape: () => setOpen(false),
        }
      : { ArrowDown: show, ArrowUp: show, Enter: show, " ": show };
    const action = keys[event.key];
    if (action) {
      event.preventDefault();
      action();
    } else if (event.key.length === 1 && event.key.trim()) {
      jumpTo(event.key.toLowerCase());
    }
  }

  /** Type a letter to jump to the next tenant starting with it. */
  function jumpTo(letter: string) {
    const from = open ? active : options.indexOf(value);
    const order = [...options.keys()].map(
      (step) => (from + 1 + step) % options.length,
    );
    const next = order.find((index) => options[index]?.startsWith(letter));
    if (next === undefined) return;
    if (open) setActive(next);
    else setChosen(options[next] ?? null);
  }

  return (
    <div className="picker">
      <span id={`${id}-label`}>{label}</span>
      <div
        role="combobox"
        className="picker-box"
        tabIndex={disabled ? -1 : 0}
        aria-labelledby={`${id}-label`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        aria-disabled={disabled || undefined}
        onClick={() => {
          if (disabled) return;
          if (open) setOpen(false);
          else show();
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
      >
        {disabled ? "..." : value}
      </div>
      {open && (
        <ul
          ref={list}
          id={`${id}-list`}
          role="listbox"
          className="picker-list"
          aria-labelledby={`${id}-label`}
        >
          {options.map((option, index) => (
            <li
              key={option}
              id={`${id}-${index}`}
              role="option"
              aria-selected={option === value}
              data-index={index}
              className={
                index === active ? "picker-option active" : "picker-option"
              }
              // Keep focus on the box, or blur closes the list first.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(index)}
            >
              {option}
            </li>
          ))}
        </ul>
      )}
      <input type="hidden" name={name} value={value} />
    </div>
  );
}
