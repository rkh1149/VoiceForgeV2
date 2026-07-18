"use client";

import { useMemo, useState, type ChangeEvent, type ReactNode } from "react";
import { closestCenter, DndContext, type DragEndEvent } from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import * as Select from "@radix-ui/react-select";
import * as Tabs from "@radix-ui/react-tabs";
import { flexRender, type Table as ReactTable } from "@tanstack/react-table";
import { clsx, type ClassValue } from "clsx";
import { Download, GripVertical, Plus, Search, Upload } from "lucide-react";
import { DayPicker } from "react-day-picker";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export type RoleAccess = {
  role: "owner" | "editor" | "viewer" | null;
  canWrite: boolean;
  canManage: boolean;
};

export function RoleAwareShell({
  access,
  title,
  children,
}: {
  access: RoleAccess;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-semibold text-slate-950">{title}</h2>
        <span className="rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600">
          {access.role ?? "signed out"}
        </span>
      </div>
      {!access.canWrite && (
        <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          You can view this area, but your role cannot make changes.
        </p>
      )}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function SearchToolbar({
  value,
  onChange,
  placeholder = "Search",
  actions,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <label className="relative block min-w-0 flex-1">
        <span className="sr-only">{placeholder}</span>
        <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="w-full rounded-md border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm text-slate-950 shadow-sm outline-none focus:border-emerald-600 focus:ring-2 focus:ring-emerald-100"
        />
      </label>
      {actions}
    </div>
  );
}

export function MetricCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string | number;
  detail?: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-2xl font-bold text-slate-950">{value}</p>
      <p className="mt-1 text-sm font-medium text-slate-600">{label}</p>
      {detail && <p className="mt-2 text-xs text-slate-400">{detail}</p>}
    </div>
  );
}

export function SimpleBarChart({
  data,
  xKey,
  yKey,
}: {
  data: Array<Record<string, string | number>>;
  xKey: string;
  yKey: string;
}) {
  return (
    <div className="h-72 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey={xKey} />
          <YAxis />
          <Tooltip />
          <Bar dataKey={yKey} fill="#047857" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function DataTable<TData>({
  table,
  emptyMessage = "No records yet.",
}: {
  table: ReactTable<TData>;
  emptyMessage?: string;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-slate-100 bg-slate-50 text-xs text-slate-500">
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <th key={header.id} className="px-3 py-2 font-semibold">
                  {header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.length === 0 ? (
            <tr>
              <td
                className="px-3 py-6 text-center text-slate-500"
                colSpan={table.getAllColumns().length || 1}
              >
                {emptyMessage}
              </td>
            </tr>
          ) : (
            table.getRowModel().rows.map((row) => (
              <tr key={row.id} className="border-b border-slate-50">
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-3 py-2 text-slate-700">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function CalendarField({
  selected,
  onSelect,
}: {
  selected?: Date;
  onSelect: (date: Date | undefined) => void;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">
        Pick date
      </Popover.Trigger>
      <Popover.Content
        aria-label="Choose date"
        className="z-10 rounded-lg border border-slate-200 bg-white p-3 shadow-lg"
      >
        <DayPicker mode="single" selected={selected} onSelect={onSelect} />
      </Popover.Content>
    </Popover.Root>
  );
}

export function CsvExportButton({
  onExport,
}: {
  onExport: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onExport}
      className="inline-flex items-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
    >
      <Download className="h-4 w-4" />
      Export CSV
    </button>
  );
}

export function PlatformFileUploadInput({
  canWrite,
  onUpload,
  accept = "image/jpeg,image/png,image/gif,image/webp,application/pdf,text/plain,text/csv",
  label = "Add attachment",
  disabled = false,
}: {
  canWrite: boolean;
  onUpload: (file: File) => Promise<void> | void;
  accept?: string;
  label?: string;
  disabled?: boolean;
}) {
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState("");

  if (!canWrite) return null;

  async function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;

    setIsUploading(true);
    setError("");
    try {
      await onUpload(file);
    } catch (uploadError) {
      setError(
        uploadError instanceof Error
          ? uploadError.message
          : "Could not upload that file.",
      );
    } finally {
      input.value = "";
      setIsUploading(false);
    }
  }

  return (
    <div className="space-y-2">
      <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
        <Upload className="h-4 w-4" />
        <span>{isUploading ? "Uploading..." : label}</span>
        <input
          aria-label={label}
          accept={accept}
          className="sr-only"
          disabled={disabled || isUploading}
          type="file"
          onChange={handleChange}
        />
      </label>
      {error && (
        <p aria-live="polite" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

export function AddButton({
  children = "Add",
  onClick,
}: {
  children?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-2 rounded-md bg-emerald-700 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-800"
    >
      <Plus className="h-4 w-4" />
      {children}
    </button>
  );
}

export function Modal({
  title,
  trigger,
  children,
}: {
  title: string;
  trigger: ReactNode;
  children: ReactNode;
}) {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-slate-950/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 w-[min(92vw,32rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-5 shadow-xl">
          <Dialog.Title className="text-lg font-semibold text-slate-950">
            {title}
          </Dialog.Title>
          <div className="mt-4">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function TabPanels({
  tabs,
}: {
  tabs: Array<{ id: string; label: string; content: ReactNode }>;
}) {
  const [activeId, setActiveId] = useState(tabs[0]?.id ?? "");
  const activeTab = tabs.find((tab) => tab.id === activeId) ?? tabs[0];

  return (
    <Tabs.Root value={activeTab?.id} onValueChange={setActiveId} className="w-full">
      <Tabs.List className="flex gap-2 border-b border-slate-200">
        {tabs.map((tab) => (
          <Tabs.Trigger
            key={tab.id}
            value={tab.id}
            className="px-3 py-2 text-sm font-medium text-slate-600 data-[state=active]:border-b-2 data-[state=active]:border-emerald-700 data-[state=active]:text-emerald-800"
          >
            {tab.label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      {activeTab && (
        <Tabs.Content value={activeTab.id} className="mt-4">
          {activeTab.content}
        </Tabs.Content>
      )}
    </Tabs.Root>
  );
}

export function SimpleSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <Select.Root value={value} onValueChange={onChange}>
      <Select.Trigger className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700">
        <Select.Value />
      </Select.Trigger>
      <Select.Content className="rounded-md border border-slate-200 bg-white shadow-lg">
        {options.map((option) => (
          <Select.Item
            key={option.value}
            value={option.value}
            className="px-3 py-2 text-sm text-slate-700"
          >
            <Select.ItemText>{option.label}</Select.ItemText>
          </Select.Item>
        ))}
      </Select.Content>
    </Select.Root>
  );
}

export function SortableList<TItem extends { id: string }>({
  items,
  onReorder,
  renderItem,
}: {
  items: TItem[];
  onReorder: (items: TItem[]) => void;
  renderItem: (item: TItem) => ReactNode;
}) {
  const ids = useMemo(() => items.map((item) => item.id), [items]);

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = items.findIndex((item) => item.id === active.id);
    const newIndex = items.findIndex((item) => item.id === over.id);
    if (oldIndex >= 0 && newIndex >= 0) {
      onReorder(arrayMove(items, oldIndex, newIndex));
    }
  }

  return (
    <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className="space-y-2">
          {items.map((item) => (
            <SortableItem key={item.id} id={item.id}>
              {renderItem(item)}
            </SortableItem>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function SortableItem({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-3 shadow-sm"
    >
      <button
        type="button"
        aria-label="Drag item"
        className="rounded-md p-1 text-slate-400 hover:bg-slate-100"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
